/* ============================================================
   Presencer — app.js
   App single-tenant-per-workspace, generica (palestra/azienda/famiglia).
   Nessun framework: stato globale S + render() che ridisegna #app.
   ============================================================ */

const APP = document.getElementById('app');
const WEEKDAYS = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
const MONTHS = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
const PERIOD_LABEL = {estate:'Estate', inverno:'Inverno', extra:'Extra', personalizzato:'Personalizzato'};
// Campi email: niente maiuscola automatica né correttore, altrimenti sulle
// tastiere mobili l'indirizzo arriva sporcato e l'accesso fallisce.
const EMAIL_ATTRS = 'type="email" inputmode="email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false"';
// Indirizzo con cui il link di recupero riapre l'APK invece del browser. Lo
// schema è dichiarato in android/app/src/main/AndroidManifest.xml e va aggiunto
// ai Redirect URLs del progetto Supabase.
const NATIVE_RECOVERY_URL = 'it.presencer.app://recovery';
const NOTIFICATION_TYPES = [
  {id:'attendance', label:'Presenze e assenze', description:'Quando una presenza viene aggiunta, cambiata o rimossa.'},
  {id:'recurring', label:'Presenze ricorrenti', description:'Quando cambia una presenza settimanale ricorrente.'},
  {id:'schedule', label:'Orari e lezioni', description:'Quando viene aggiunto, modificato o eliminato un orario.'},
  {id:'calendar', label:'Calendari', description:'Quando cambia un calendario o la sua data di attivazione.'},
  {id:'lesson_log', label:'Registri lezione', description:'Quando viene modificata una voce del registro.'},
  {id:'members', label:'Membri', description:'Quando entra, cambia ruolo o viene rimosso un membro.'},
  {id:'absence', label:'Richieste di assenza', description:'Quando qualcuno chiede di assentarsi e quando la richiesta viene decisa.'},
];
const DEFAULT_NOTIFICATION_PREFERENCES = {
  enabled:true,   // di serie le notifiche sono attive: manca solo il permesso del dispositivo
  attendance:true,
  recurring:true,
  schedule:true,
  calendar:true,
  lesson_log:true,
  members:true,
  absence:true,
};
// Regole compensi di serie: in compresenza ognuno prende 2/3 della tariffa, il
// maestro caposcuola presente prende tutto.
const DEFAULT_PAY = {default_rate:0, rates:{}, copresence_factor:0.6667, master_takes_all:true};
const GRADE_LABEL = {istruttore:'Istruttore', maestro:'Maestro caposcuola'};

let sb = null;
const S = {
  view: 'loading',      // loading | setup | auth | guestname | reconnect | no-workspace | newpass | app
  authTab: 'login',     // login | register | join | reset
  authErr: '',
  authMsg: '',          // messaggio positivo sulla schermata di accesso (es. "link inviato")
  authEmail: '',        // email già digitata, riportata sulla schermata di recupero
  reconnectMsg: '',     // testo della schermata "sei collegato ma manca la rete"
  busy: false,

  session: null,
  profile: null,        // {id, user_id, workspace_id, name, role, color} — profilo nello spazio ATTIVO
  workspace: null,      // {id, name, invite_code, active_calendar_id}
  myProfiles: [],       // tutti i profili (uno per spazio) dell'utente loggato
  myWorkspaces: [],     // {id,name} degli spazi corrispondenti a myProfiles

  guest: null,          // {token, name, workspace_id, expires_at} quando accesso rapido
  pendingGuestToken: null,

  tab: 'presenze',      // presenze | ore | calendari | istruttori | profilo
  calendars: [],
  calendarPeriods: [],  // [{id, workspace_id, calendar_id, start_date}]
  selectedCalendarId: null, // ID del calendario effettivo per la data visualizzata
  selectedCalendarOverrideId: null, // manual override se l'utente sceglie un calendario specifico nel menu
  weekOffset: 0,
  navDir: null,          // 'next' | 'prev' | null — direzione per l'animazione di cambio settimana
  slots: [],
  extraSlots: [],
  attendance: [],
  recurring: [],
  lessonLogs: [],       // registro lezione: cosa è stato fatto in ogni lezione/data
  cancellations: [],    // lezioni settimanali annullate in una data precisa
  absenceRequests: [],  // richieste di assenza (con lezione incorporata)
  showAllMatrix: false,
  matrixFullscreen: false,  // vista Tutti a tutta pagina, senza barre
  presenceSaving: false,
  weekLoading: false,
  weekLoadFailed: false,
  weekDataContext: null,  // a quale settimana/spazio appartengono i dati gia' a schermo
  presenceNeedsRefresh: false,
  syncBusy: false,
  dataError: null,

  instructors: [],
  guestLinks: [],

  // scheda Ore: periodo, persona filtrata (solo admin) e dati caricati
  reportMode: 'month',  // week | month | custom
  reportFrom: '',
  reportTo: '',
  reportPerson: '',
  reportDetail: false,
  reportData: null,
  reportLoading: false,
  paySettings: null,
  backupBusy: false,   // esportazione o ripristino in corso

  notificationPreferences: Object.assign({}, DEFAULT_NOTIFICATION_PREFERENCES),
  notificationPermission: 'prompt', // prompt | granted | denied | unavailable
  pushToken: null,      // recapito Firebase di questo telefono
  pushActive: false,    // true = le notifiche arrivano dal server, anche ad app chiusa
  notificationSetupMissing: false,

  modal: null,          // {type, ...data}
  toast: '',
};

let notificationChannel = null;
let weekLoadVersion = 0;

/* ---------------- PWA install + "ricordami" ---------------- */
let deferredInstallPrompt = null;
let installPopupShown = false;
let rememberMe = localStorage.getItem('rememberMe') !== '0'; // default: sì, ricordami

// Guardie per il flusso di autenticazione:
// - authFlowBusy: registrazione/join in corso (la sessione arriva PRIMA che
//   profilo e spazio esistano, l'ascoltatore non deve intromettersi)
// - signInBusy: caricamento post-login già in corso (evita doppi caricamenti)
// - authWatchdog: sblocca il pulsante se la risposta non arriva mai
// - recoveryFlow: si arriva dal link "password dimenticata": la sessione che
//   nasce da quel link serve solo a scegliere la nuova password, non a entrare
let authFlowBusy = false;
let signInBusy = false;
let authWatchdog = null;
let recoveryFlow = false;

// storage per la sessione Supabase: se "ricordami" è attivo usa localStorage (persiste alla
// chiusura del browser), altrimenti sessionStorage (sparisce a fine sessione). In lettura
// controlla entrambi così il reload funziona in ogni caso.
const authStorage = {
  getItem: (k)=>{ const v = localStorage.getItem(k); return v!==null ? v : sessionStorage.getItem(k); },
  setItem: (k,v)=>{
    if(rememberMe){ localStorage.setItem(k,v); sessionStorage.removeItem(k); }
    else { sessionStorage.setItem(k,v); localStorage.removeItem(k); }
  },
  removeItem: (k)=>{ localStorage.removeItem(k); sessionStorage.removeItem(k); },
};

function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
// 'prompt' = prompt nativo disponibile (beforeinstallprompt già arrivato);
// 'android' = Android/Chromium senza prompt nativo (istruzioni manuali dal menu ⋮);
// 'ios' = Safari iOS (istruzioni manuali); null = niente da mostrare
function installMode(){
  if(isStandalone()) return null;
  if(localStorage.getItem('installDismissed')==='1') return null;
  if(deferredInstallPrompt) return 'prompt';
  const ua = navigator.userAgent || '';
  // iOS: Safari (o browser che usano WebKit) → istruzioni "Aggiungi a Home"
  if(/iphone|ipad|ipod/i.test(ua)) return 'ios';
  // Android su browser Chromium: il prompt nativo può tardare (engagement),
  // non essere ancora "controllato" dal service worker al primo caricamento, o
  // essere soppresso da Chrome per ~90 giorni dopo un rifiuto. In tutti questi
  // casi offriamo comunque un percorso manuale invece di non mostrare nulla.
  if(/android/i.test(ua) && /chrome|crios|edg|samsungbrowser/i.test(ua)) return 'android';
  return null;
}
// Lancia il prompt nativo. Ritorna true se il prompt è stato mostrato.
async function firePrompt(){
  if(!deferredInstallPrompt) return false;
  const p = deferredInstallPrompt;
  deferredInstallPrompt = null;
  try{
    p.prompt();
    await p.userChoice;
  }catch(e){
    return false;
  }
  render();
  return true;
}

async function doInstall(){
  // 1) prompt nativo già disponibile → installazione immediata
  if(await firePrompt()) return;

  // 2) iOS: nessuna API di installazione, servono le istruzioni manuali
  if(/iphone|ipad|ipod/i.test(navigator.userAgent||'')){
    openModal({type:'ios-install'});
    return;
  }

  // 3) Android/desktop Chromium: il beforeinstallprompt può arrivare con qualche
  // istante di ritardo (service worker non ancora controller, engagement, ecc.).
  // Aspettiamo brevemente e, se arriva, partiamo diretti senza mostrare istruzioni.
  const got = await waitForPrompt(2500);
  if(got && await firePrompt()) return;

  // 4) davvero non installabile via API → fallback istruzioni
  openModal({type:'android-install'});
}

// Attende l'evento beforeinstallprompt fino a ms millisecondi.
function waitForPrompt(ms){
  if(deferredInstallPrompt) return Promise.resolve(true);
  return new Promise(resolve=>{
    let done = false;
    const on = ()=>{ if(done) return; done = true; cleanup(); resolve(true); };
    const cleanup = ()=>{
      window.removeEventListener('beforeinstallprompt', on);
      clearTimeout(timer);
    };
    const timer = setTimeout(()=>{ if(done) return; done = true; cleanup(); resolve(!!deferredInstallPrompt); }, ms);
    window.addEventListener('beforeinstallprompt', on);
  });
}
function dismissInstall(){
  localStorage.setItem('installDismissed','1');
  render();
}
// popup automatico ai primi accessi (una sola volta per dispositivo)
function maybeShowInstallPopup(){
  if(installPopupShown) return;
  if(S.view!=='app' || S.modal) return;
  if(isStandalone()) return;
  if(localStorage.getItem('installPopupSeen')==='1') return;
  if(localStorage.getItem('installDismissed')==='1') return;
  const im = installMode();
  if(!im) return; // non installabile ora (né evento nativo né iOS Safari)
  installPopupShown = true;
  localStorage.setItem('installPopupSeen','1');
  openModal({type:'install-prompt', mode: im});
}
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  render();
  // se l'evento arriva dopo che l'app è già aperta, proponi comunque il popup
  setTimeout(maybeShowInstallPopup, 400);
});
window.addEventListener('appinstalled', ()=>{
  deferredInstallPrompt = null;
  localStorage.setItem('installDismissed','1');
  render();
});
// Diagnostica: apri la console del browser e digita pwaDebug() per capire
// perché il popup non compare (prompt nativo arrivato? SW attivo? flag salvati?).
// resetInstall() cancella i flag così il popup può ricomparire.
window.pwaDebug = function(){
  const d = {
    standalone: isStandalone(),
    beforeinstallpromptRicevuto: !!deferredInstallPrompt,
    installMode: installMode(),
    swController: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    installPopupSeen: localStorage.getItem('installPopupSeen'),
    installDismissed: localStorage.getItem('installDismissed'),
    userAgent: navigator.userAgent,
  };
  console.table(d);
  return d;
};
window.resetInstall = function(){
  localStorage.removeItem('installPopupSeen');
  localStorage.removeItem('installDismissed');
  installPopupShown = false;
  console.log('Flag install azzerati. Ricarica la pagina.');
};

/* ---------------- notifiche eventi ---------------- */
function notificationPrefsKey(){
  return S.profile ? `notificationPrefs_${S.profile.id}` : 'notificationPrefs';
}
function notificationCursorKey(){
  return S.profile ? `notificationCursor_${S.profile.id}` : 'notificationCursor';
}
function nativeNotifications(){
  return window.PresencerNative && window.PresencerNative.isNative ? window.PresencerNative : null;
}
function readLocalNotificationPreferences(){
  try{
    const saved = JSON.parse(localStorage.getItem(notificationPrefsKey()) || '{}');
    return Object.assign({}, DEFAULT_NOTIFICATION_PREFERENCES, saved);
  }catch(e){
    return Object.assign({}, DEFAULT_NOTIFICATION_PREFERENCES);
  }
}
function persistLocalNotificationPreferences(){
  localStorage.setItem(notificationPrefsKey(), JSON.stringify(S.notificationPreferences));
}
async function refreshNotificationPermission(){
  try{
    const native = nativeNotifications();
    if(native) S.notificationPermission = await native.checkPermission();
    else if(!('Notification' in window)) S.notificationPermission = 'unavailable';
    else S.notificationPermission = Notification.permission;
  }catch(e){
    S.notificationPermission = 'unavailable';
  }
}
async function loadNotificationPreferences(){
  S.notificationPreferences = readLocalNotificationPreferences();
  S.notificationSetupMissing = false;
  await refreshNotificationPermission();
  try{
    const {data, error} = await sb.from('notification_preferences')
      .select('*').eq('profile_id', S.profile.id).maybeSingle();
    if(error){
      if(error.code==='42P01' || error.code==='PGRST205') S.notificationSetupMissing = true;
      return;
    }
    if(data){
      NOTIFICATION_TYPES.forEach(t=>{ S.notificationPreferences[t.id] = data[t.id] !== false; });
      S.notificationPreferences.enabled = data.enabled === true;
      persistLocalNotificationPreferences();
    }
  }catch(e){}
}
/* ---------------- notifiche push (server → telefono, anche ad app chiusa) ----------------
   Il token è il "recapito" del telefono: lo salviamo accanto al profilo così la
   Edge Function sa dove spedire. Se le push non sono disponibili non succede
   nulla: restano le notifiche locali di quando l'app è aperta. */
let pushSyncInFlight = false;
async function syncPushToken(){
  const native = nativeNotifications();
  if(!native || !native.registerPush || !S.profile || !S.session) return;
  if(!S.notificationPreferences.enabled) return;
  if(pushSyncInFlight) return;   // un solo tentativo per volta
  pushSyncInFlight = true;
  try{
    const token = await native.registerPush();
    if(!token){ S.pushActive = false; return; }
    const {error} = await sb.from('device_tokens').upsert({
      profile_id: S.profile.id,
      user_id: S.session.user.id,
      token,
      platform: 'android',
      updated_at: new Date().toISOString(),
    }, {onConflict:'profile_id,token'});
    if(error){
      // Migrazione non ancora eseguita: nessun danno, solo niente push.
      if(error.code!=='42P01' && error.code!=='PGRST205') console.error(error);
      S.pushActive = false;
      return;
    }
    S.pushToken = token;
    S.pushActive = true;
  }catch(err){
    console.warn('Push non attivate', err);
    S.pushActive = false;
  }finally{
    pushSyncInFlight = false;
  }
}

/* Al primo avvio il recapito puo' mancare: rete non ancora pronta, servizi Google
   in ritardo, Firebase che tarda a rispondere. Senza un nuovo tentativo il telefono
   resta senza indirizzo e le push non arrivano piu', finche' non si spengono e
   riaccendono le notifiche a mano. Qui riproviamo da soli, in silenzio. */
function retryPushTokenIfMissing(){
  if(S.pushActive) return;
  if(!S.notificationPreferences.enabled) return;
  if(S.notificationPermission!=='granted') return;   // niente richieste a sorpresa
  syncPushToken();
}

/* Le notifiche sono attive di serie: se il dispositivo non ha ancora deciso glielo
   chiediamo una volta. Sul web resta il pulsante "Consenti notifiche", perche'
   li' la richiesta deve partire da un tuo gesto. Un rifiuto resta un rifiuto. */
async function requestNotificationPermissionIfDefault(){
  if(!nativeNotifications()) return;
  if(!S.notificationPreferences.enabled) return;
  if(S.notificationPermission!=='prompt') return;
  await enableDeviceNotifications();
}

/* All'uscita togliamo il recapito, altrimenti il telefono continuerebbe a
   ricevere le notifiche di uno spazio a cui non appartiene più. */
async function removePushToken(){
  const native = nativeNotifications();
  try{
    if(S.pushToken && S.profile){
      await sb.from('device_tokens').delete()
        .eq('profile_id', S.profile.id).eq('token', S.pushToken);
    }
    if(native && native.unregisterPush) await native.unregisterPush();
  }catch(err){ console.warn(err); }
  S.pushToken = null;
  S.pushActive = false;
}

async function saveNotificationPreferences(){
  persistLocalNotificationPreferences();
  if(!S.profile) return;
  const payload = {profile_id:S.profile.id, enabled:!!S.notificationPreferences.enabled};
  NOTIFICATION_TYPES.forEach(t=>{ payload[t.id] = !!S.notificationPreferences[t.id]; });
  try{
    const {error} = await sb.from('notification_preferences').upsert(payload, {onConflict:'profile_id'});
    if(error && (error.code==='42P01' || error.code==='PGRST205')) S.notificationSetupMissing = true;
  }catch(e){}
}
async function enableDeviceNotifications(){
  try{
    const native = nativeNotifications();
    let permission;
    if(native) permission = await native.requestPermission();
    else if('Notification' in window) permission = await Notification.requestPermission();
    else permission = 'unavailable';
    S.notificationPermission = permission;
    if(permission==='granted'){
      S.notificationPreferences.enabled = true;
      await saveNotificationPreferences();
      await syncPushToken();
      toast(S.pushActive ? 'Notifiche attivate, anche ad app chiusa.' : 'Notifiche attivate.');
    } else {
      S.notificationPreferences.enabled = false;
      await saveNotificationPreferences();
      toast(permission==='denied' ? 'Notifiche bloccate nelle impostazioni del dispositivo.' : 'Notifiche non disponibili.');
    }
    render();
  }catch(e){
    toast('Impossibile attivare le notifiche.');
  }
}
async function setNotificationPreference(key, enabled){
  S.notificationPreferences[key] = !!enabled;
  if(key==='enabled' && enabled && S.notificationPermission!=='granted'){
    await enableDeviceNotifications();
    return;
  }
  await saveNotificationPreferences();
  render();
}
function notificationPermissionText(){
  if(S.notificationPermission==='granted') return 'Autorizzate dal dispositivo';
  if(S.notificationPermission==='denied') return 'Bloccate dal dispositivo: riattivale dalle impostazioni dell’app';
  if(S.notificationPermission==='unavailable') return 'Non disponibili su questo dispositivo o browser';
  return 'Serve la tua autorizzazione';
}
async function deliverEventNotification(event, replay){
  const prefs = S.notificationPreferences;
  if(!prefs.enabled || !prefs[event.category]) return;
  if(event.actor_profile_id && S.profile && event.actor_profile_id===S.profile.id) return;

  // Il server le ha già spedite mentre l'app era chiusa: non mostriamole due volte.
  if(replay && S.pushActive){
    if(document.visibilityState==='visible') toast(`${event.title}: ${event.body}`);
    return;
  }

  const native = nativeNotifications();
  try{
    if(native && S.notificationPermission==='granted'){
      await native.notify({
        id:event.id,
        category:event.category,
        title:event.title || 'Presencer',
        body:event.body || 'Un evento è stato modificato.',
      });
    } else if(S.notificationPermission==='granted' && document.visibilityState!=='visible'){
      const options = {
        body:event.body || 'Un evento è stato modificato.',
        icon:'./icons/icon-192.png',
        badge:'./icons/icon-192.png',
        tag:`presencer-${event.id}`,
        data:{url:'./'},
      };
      const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
      if(reg) await reg.showNotification(event.title || 'Presencer', options);
      else new Notification(event.title || 'Presencer', options);
    }
  }catch(e){ console.warn('Notifica non mostrata', e); }

  if(document.visibilityState==='visible') toast(`${event.title}: ${event.body}`);
}
async function handleAppEvent(event, replay){
  if(!event || !event.id) return;
  if(event.workspace_id && event.workspace_id!==S.workspace?.id) return;
  // I ruoli arrivano dal profilo nel database, non dal token della sessione.
  if(event.category==='members' && event.metadata?.record_id===myProfileId()){
    await loadInstructors();
  }
  localStorage.setItem(notificationCursorKey(), String(event.id));
  await deliverEventNotification(event, replay);
}
async function catchUpNotificationEvents(){
  if(!S.profile || !S.workspace) return;
  const cursor = localStorage.getItem(notificationCursorKey());
  try{
    if(!cursor){
      const {data, error} = await sb.from('app_events').select('id')
        .eq('workspace_id', S.workspace.id).order('id', {ascending:false}).limit(1);
      if(error){
        if(error.code==='42P01' || error.code==='PGRST205') S.notificationSetupMissing = true;
        return;
      }
      if(data && data[0]) localStorage.setItem(notificationCursorKey(), String(data[0].id));
      return;
    }
    const {data, error} = await sb.from('app_events').select('*')
      .eq('workspace_id', S.workspace.id).gt('id', cursor).order('id', {ascending:true}).limit(10);
    if(error) return;
    // recupero all'apertura: con le push attive queste notifiche sono già
    // arrivate sul telefono, qui serve solo allineare i dati.
    for(const event of (data||[])) await handleAppEvent(event, true);
  }catch(e){}
}
async function startNotificationListener(){
  if(notificationChannel){
    try{ await sb.removeChannel(notificationChannel); }catch(e){}
    notificationChannel = null;
  }
  if(!S.profile || !S.workspace) return;
  await catchUpNotificationEvents();
  notificationChannel = sb.channel(`app-events-${S.profile.id}`)
    .on('postgres_changes', {
      event:'INSERT', schema:'public', table:'app_events',
      filter:`workspace_id=eq.${S.workspace.id}`,
    }, payload=> handleAppEvent(payload.new))
    .subscribe();
}

document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState!=='visible') return;
  if(S.view==='app' && !isGuest()){
    // Mentre l'app era in secondo piano Android sospende la WebView e il rinnovo
    // automatico del token si ferma: al ritorno lo rinnoviamo noi, altrimenti la
    // prima richiesta fallisce con 401 e sembra un logout improvviso.
    refreshSessionIfStale();
    loadInstructors();
    catchUpNotificationEvents();
    retryPushTokenIfMissing();
  }
  if(S.view==='reconnect') retryAfterReconnect();
});

// Tornata la linea, riprova da solo: sull'APK capita spesso di aprire l'app
// prima che WiFi o dati siano pronti.
window.addEventListener('online', ()=>{
  if(S.view==='reconnect') retryAfterReconnect();
  if(S.view==='app' && !isGuest()) retryPushTokenIfMissing();
});

/* Rinnova il token se sta per scadere (o è già scaduto) */
async function refreshSessionIfStale(){
  if(!sb || !S.session || isGuest()) return;
  const expires = S.session.expires_at ? S.session.expires_at*1000 : 0;
  if(expires && expires - Date.now() > 120000) return;   // ancora buono per 2 minuti
  try{
    const {data, error} = await sb.auth.refreshSession();
    if(!error && data && data.session) S.session = data.session;
  }catch(e){ console.error(e); }
}

function dataErrorMessage(error){
  const code = error?.code || '';
  if(code==='GUEST_EXPIRED') return 'Accesso rapido scaduto. Chiedi un nuovo link all’amministratore.';
  if(code==='MEMBERSHIP_MISSING') return 'Non risulti più membro di questo spazio. Contatta l’amministratore.';
  if(navigator.onLine===false || /fetch|network|offline/i.test(error?.message || '')){
    return 'Connessione non disponibile. Riconnettiti e premi “Aggiorna dati” prima di riprovare.';
  }
  if(['PGRST301','PGRST302','PGRST303'].includes(code) || error?.status===401){
    return 'Sessione scaduta. Esci e accedi di nuovo.';
  }
  if(code==='42501') return 'Permesso negato. Aggiorna i dati per verificare il tuo ruolo; puoi modificare solo le tue presenze.';
  if(code==='PGRST116') return 'La riga non è stata modificata: potrebbe essere stata rimossa oppure non essere più accessibile. Aggiorna i dati.';
  if(code==='23505') return 'Questa presenza è già stata salvata da un’altra sessione. Aggiorna i dati.';
  if(code==='42703' && /record .* has no field/i.test(error?.message || '')){
    return 'Errore del database nelle notifiche. L’amministratore deve rieseguire migration_notifications.sql aggiornato in Supabase.';
  }
  if(['42P01','42703','42883','PGRST204','PGRST205'].includes(code)){
    return 'Il database richiede un aggiornamento. L’amministratore deve verificare le migrazioni SQL del progetto.';
  }
  return 'Operazione non completata. Aggiorna i dati prima di riprovare; se persiste, comunica il codice all’amministratore.';
}

function showDataError(error, action){
  const code = String(error?.code || 'RETE_O_SERVER');
  console.error('Presencer: '+action, error);
  S.dataError = {action, code, message:dataErrorMessage(error)};
  render();
}

async function checkedRows(query){
  const {data, error} = await query;
  if(error) throw error;
  return data || [];
}

async function checkedRow(query){
  const {data, error} = await query.single();
  if(error) throw error;
  if(!data) throw {code:'PGRST116'};
  return data;
}

function presenceContext(){
  return [S.workspace?.id, myProfileId(), S.guest?.token, S.weekOffset, S.selectedCalendarOverrideId].join('|');
}

function presenceControlsDisabled(){
  return S.presenceSaving || S.weekLoading || S.weekLoadFailed || S.presenceNeedsRefresh || S.syncBusy;
}

async function runPresenceWrite(action, write){
  if(presenceControlsDisabled()) return false;
  const context = presenceContext();
  S.presenceSaving = true;
  S.dataError = null;
  render();
  try{
    if(navigator.onLine===false) throw {message:'offline'};
    if(isGuest() && new Date(S.guest.expires_at)<=new Date()) throw {code:'GUEST_EXPIRED'};
    const apply = await write();
    if(context===presenceContext()) apply();
    return true;
  }catch(error){
    if(context===presenceContext()){
      // Una risposta persa può nascondere una scrittura riuscita: rileggere prima
      // di consentire un nuovo inserimento evita duplicati e falsi successi.
      S.presenceNeedsRefresh = true;
      showDataError(error, action);
    }
    return false;
  }finally{
    S.presenceSaving = false;
    render();
  }
}

async function refreshCurrentData(){
  if(S.syncBusy || S.presenceSaving || !S.workspace) return;
  S.syncBusy = true;
  S.dataError = null;
  render();
  try{
    if(!await loadInstructors()) return;
    if(!await loadCalendars()) return;
    await refreshWeekData();
  }finally{
    S.syncBusy = false;
    render();
  }
}

/* Il messaggio vive fuori dall'albero della pagina: comparire o sparire non
   costringe piu' l'app a ridisegnarsi (e a far lampeggiare popup e calendario). */
let toastEl = null, toastTimer = null;
function toast(msg){
  S.toast = msg;
  if(!toastEl){ toastEl = document.createElement('div'); toastEl.className = 'toast'; }
  toastEl.textContent = msg;
  if(!toastEl.isConnected) document.body.appendChild(toastEl);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{
    S.toast = '';
    if(toastEl && toastEl.isConnected) toastEl.remove();
  }, 2600);
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
function nextMondayISO(){
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // 0=lun, 6=dom
  const daysUntilNextMon = 7 - day;
  const nextMon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (daysUntilNextMon === 0 ? 7 : daysUntilNextMon));
  return toISO(nextMon);
}
function fmtHM(t){ return t ? t.slice(0,5) : ''; }

/* Determina quale calendario è attivo per una data specifica in base alla cronologia periodi */
function calendarForDate(dateStr){
  if(S.calendarPeriods && S.calendarPeriods.length){
    const valid = S.calendarPeriods
      .filter(p => p.start_date <= dateStr)
      .sort((a, b) => b.start_date.localeCompare(a.start_date));
    if(valid.length) return valid[0].calendar_id;
    // Se la data è antecedente a tutti i periodi, usa il primo periodo disponibile
    const sorted = [...S.calendarPeriods].sort((a, b) => a.start_date.localeCompare(b.start_date));
    if(sorted.length) return sorted[0].calendar_id;
  }
  // Fallback se la tabella calendar_periods non è ancora popolata
  const ws = S.workspace;
  if(ws && ws.scheduled_calendar_id && ws.scheduled_calendar_date){
    if(dateStr >= ws.scheduled_calendar_date) return ws.scheduled_calendar_id;
    if(ws.active_calendar_id) return ws.active_calendar_id;
  }
  if(ws && ws.active_calendar_id) return ws.active_calendar_id;
  return S.calendars.length ? S.calendars[0].id : null;
}

/* Restituisce l'ID del calendario per una settimana (a partire dal lunedì) */
function getEffectiveCalendarForWeek(monday){
  if(S.selectedCalendarOverrideId) return S.selectedCalendarOverrideId;
  const mondayStr = toISO(monday);
  return calendarForDate(mondayStr) || (S.calendars.length ? S.calendars[0].id : null);
}

/* ---------------- boot ---------------- */
async function boot(){
  if(!window.SUPABASE_URL || window.SUPABASE_URL.indexOf('INCOLLA_QUI') === 0){
    S.view='setup'; render(); return;
  }
  // La libreria Supabase arriva dalla CDN: se la rete manca al primo avvio
  // window.supabase non esiste e l'app resterebbe su schermata bianca.
  if(!window.supabase || !window.supabase.createClient){
    S.view='setup';
    S.setupMsg = 'Non riesco a caricare i componenti dell\'app. Controlla la connessione a internet e riapri Presencer.';
    render(); return;
  }
  sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, storage: authStorage }
  });

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

  // Sul web il link "password dimenticata" riporta qui con i token nel frammento
  // (#access_token=...&type=recovery). Va riconosciuto PRIMA che parta l'accesso
  // normale, altrimenti si entrerebbe nell'app senza cambiare niente.
  const webLink = readAuthLink(hashParams(location.hash));
  if(webLink && webLink.type==='recovery'){
    // Il frammento resta dov'è: a leggerlo (e a ripulirlo) ci pensa supabase-js.
    recoveryFlow = true;
    S.view = 'loading';
  } else if(webLink && webLink.type==='error'){
    S.view = 'auth'; S.authTab = 'login'; S.authErr = webLink.message;
    history.replaceState(null, '', location.pathname + location.search);
    render();
  }

  // Nell'APK lo stesso link non passa dal frammento della pagina: Android apre
  // l'app con l'indirizzo it.presencer.app://recovery#... Va letto qui, prima
  // dell'accesso, sia quando l'app parte da zero sia quando è già aperta.
  const native = window.PresencerNative;
  let launchUrl = null;
  if(native && native.isNative){
    if(native.onAppUrlOpen) native.onAppUrlOpen(handleAppLink);
    if(native.getLaunchUrl){
      try{ launchUrl = await native.getLaunchUrl(); }catch(err){ console.warn(err); }
    }
    const launchLink = readAuthLink(hashParams(launchUrl));
    if(!launchLink) launchUrl = null;
    else if(launchLink.type==='error'){
      // Non blocchiamo l'avvio: il messaggio compare se si finisce sull'accesso.
      S.authTab = 'login'; S.authErr = launchLink.message;
      launchUrl = null;
    }
  }

  sb.auth.onAuthStateChange((event, session)=>{
    // supabase-js invoca questo callback mentre tiene il lock interno sull'auth:
    // chiamarci dentro altre API (sb.from, getSession...) può bloccare tutto a
    // tempo indeterminato. Rimandiamo il lavoro fuori dal callback.
    setTimeout(()=> onAuthEvent(event, session), 0);
  });

  // Il link ha appena aperto l'app: la sessione da usare è la sua, non quella
  // eventualmente rimasta in memoria.
  if(launchUrl){ handleAppLink(launchUrl); return; }

  sb.auth.getSession().then(({data})=>{
    if(authFlowBusy) return;                 // registrazione in corso: la gestisce lei
    if(recoveryFlow){
      if(data && data.session) S.session = data.session;
      enterPasswordRecovery();
      return;
    }
    if(data && data.session) startSession(data.session);
    else if(S.view==='loading'){ S.view='auth'; render(); }
  }).catch(err=>{
    console.error(err);
    if(S.view==='loading'){
      S.view='auth';
      S.authErr = 'Non riesco a contattare il server. Controlla la connessione e riprova.';
      render();
    }
  });
}

/* Eventi di autenticazione, eseguiti fuori dal lock di supabase-js */
function onAuthEvent(event, session){
  if(event==='TOKEN_REFRESHED' || event==='USER_UPDATED'){ if(session) S.session=session; return; }
  if(event==='SIGNED_OUT'){
    clearAuthWatchdog();
    if(notificationChannel) sb.removeChannel(notificationChannel).catch(()=>{});
    notificationChannel = null;
    S.session=null; S.profile=null; S.workspace=null; S.myProfiles=[]; S.myWorkspaces=[];
    S.busy=false; S.view='auth'; render(); return;
  }
  // Recupero password: la sessione nata dal link vale solo per impostare la
  // nuova password, non per entrare nell'app.
  if(recoveryFlow){
    if(session){ S.session = session; enterPasswordRecovery(); }
    return;
  }
  // Durante registrazione/join la sessione arriva mentre profilo e spazio non
  // esistono ancora: entrare qui mostrerebbe "Profilo non trovato" a caso.
  if(authFlowBusy){ if(session) S.session = session; return; }
  if(session) startSession(session);
}

/* Avvia il caricamento post-login, una sola volta per sessione */
function startSession(session){
  const same = S.session && S.session.user.id === session.user.id;
  S.session = session;
  if(same && (signInBusy || S.view==='app' || S.view==='no-workspace')) return;
  handleSignedIn();
}

function armAuthWatchdog(msg){
  clearAuthWatchdog();
  authWatchdog = setTimeout(()=>{
    authWatchdog = null;
    if(S.view==='auth' || S.view==='loading'){
      S.busy=false; signInBusy=false; authFlowBusy=false;
      S.view='auth'; S.authErr = msg; render();
    }
  }, 25000);
}

function clearAuthWatchdog(){
  if(authWatchdog){ clearTimeout(authWatchdog); authWatchdog = null; }
}

/* Errore passeggero (rete assente, WiFi che cambia, server lento): riprovare ha senso */
function isTransientError(err){
  if(!err) return false;
  if(navigator.onLine===false) return true;
  const msg = ((err.message||'') + ' ' + (err.details||'')).toLowerCase();
  if(/failed to fetch|networkerror|network request failed|load failed|timeout|aborted|econn/.test(msg)) return true;
  const status = err.status || err.statusCode;
  return status===0 || status===408 || status===429 || (status>=500 && status<=599);
}

/* Il token non è più valido: qui sì che serve rifare l'accesso */
function isAuthExpiredError(err){
  if(!err) return false;
  const code = err.code || '';
  const msg = (err.message||'').toLowerCase();
  return err.status===401 || ['PGRST301','PGRST302','PGRST303'].includes(code)
    || msg.includes('jwt expired') || msg.includes('invalid claim') || msg.includes('refresh token');
}

async function handleSignedIn(){
  if(signInBusy) return;
  signInBusy = true;
  try{
    const uid = S.session.user.id;
    await loadMyProfiles();
    if(!S.myProfiles.length){
      // Account valido ma senza profilo (di solito una registrazione interrotta
      // a metà): invece di un vicolo cieco offriamo di creare o raggiungere uno spazio.
      clearAuthWatchdog();
      S.busy=false; S.authErr=''; S.view='no-workspace'; render(); return;
    }
    const remembered = localStorage.getItem('activeWs_'+uid);
    const chosen = S.myProfiles.find(p=>p.workspace_id===remembered) || S.myProfiles[0];
    await activateProfile(chosen, 'login');
  }catch(err){
    console.error(err);
    clearAuthWatchdog();
    S.busy=false;

    // Un intoppo di rete NON deve buttare fuori chi ha fatto l'accesso: la
    // sessione resta valida, mostriamo una schermata di riconnessione.
    if(isTransientError(err)){
      S.reconnectMsg = navigator.onLine===false
        ? 'Sei senza connessione. Appena torni online riprovo da solo.'
        : 'Non riesco a contattare il server. Controlla la connessione.';
      S.view='reconnect'; render(); return;
    }

    // Token scaduto: proviamo a rinnovarlo prima di chiedere di riaccedere.
    if(isAuthExpiredError(err)){
      try{
        const {data, error} = await sb.auth.refreshSession();
        if(!error && data && data.session){
          S.session = data.session;
          signInBusy = false;
          return handleSignedIn();
        }
      }catch(e){ console.error(e); }
      S.view='auth';
      S.authErr = 'La sessione è scaduta: accedi di nuovo.';
      render(); return;
    }

    S.view='auth';
    S.authErr = authErrorMessage(err, 'Errore di caricamento. Riprova.');
    render();
  }finally{
    signInBusy = false;
  }
}

/* Ritenta le letture fallite per motivi passeggeri: all'avvio dell'APK la rete
   spesso non è ancora pronta e un singolo tentativo fallisce senza motivo. */
async function withRetry(run, attempts=3){
  let last;
  for(let i=0; i<attempts; i++){
    try{
      const {data, error} = await run();
      if(!error) return data;
      last = error;
    }catch(err){ last = err; }
    if(!isTransientError(last)) throw last;
    if(i < attempts-1) await new Promise(r=> setTimeout(r, 600*(i+1)));
  }
  throw last;
}

async function loadMyProfiles(){
  const uid = S.session.user.id;
  const profs = await withRetry(()=> sb.from('profiles').select('*').eq('user_id', uid).order('created_at'));
  S.myProfiles = profs || [];
  if(S.myProfiles.length){
    const ids = S.myProfiles.map(p=>p.workspace_id);
    const wss = await withRetry(()=> sb.from('workspaces').select('id,name').in('id', ids));
    S.myWorkspaces = wss || [];
  } else {
    S.myWorkspaces = [];
  }
}

async function activateProfile(prof, reason){
  S.profile = prof;
  let ws = null, wsErr = null;
  try{
    ws = await withRetry(()=> sb.from('workspaces').select('*').eq('id', prof.workspace_id).maybeSingle());
  }catch(err){ wsErr = err; }
  if(wsErr || !ws){
    // Senza spazio non c'è nulla da mostrare: non lasciamo l'accesso appeso.
    console.error(wsErr);
    if(S.view==='app'){ toast('Errore caricamento spazio.'); return; }
    clearAuthWatchdog();
    S.busy = false;
    if(isTransientError(wsErr)){
      // Problema di rete: la sessione resta valida, niente logout a sorpresa.
      S.reconnectMsg = 'Non riesco a caricare il tuo spazio. Controlla la connessione.';
      S.view='reconnect'; render(); return;
    }
    authFail(authErrorMessage(wsErr, 'Non riesco a caricare il tuo spazio. Riprova.'));
    return;
  }
  S.workspace = ws;
  S.weekOffset = 0;
  S.selectedCalendarOverrideId = null;
  S.tab = 'presenze';
  S.calendars = []; S.calendarPeriods = []; S.slots = []; S.extraSlots = []; S.attendance = []; S.recurring = []; S.lessonLogs = []; S.instructors = []; S.guestLinks = [];
  S.cancellations = []; S.absenceRequests = []; S.reportData = null; S.paySettings = null; S.reportPerson = '';
  S.dataError = null; S.weekLoadFailed = false; S.presenceNeedsRefresh = false;
  localStorage.setItem('activeWs_'+S.session.user.id, prof.workspace_id);
  clearAuthWatchdog();
  S.busy = false;
  S.authErr = '';
  S.view='app';
  render();
  await loadCalendars();
  await applyScheduledCalendarIfDue();
  await loadInstructors();
  await refreshWeekData();
  await loadNotificationPreferences();
  render();
  await requestNotificationPermissionIfDefault();
  await startNotificationListener();
  await syncPushToken();
  if(reason==='login' && S.myProfiles.length>1) toast(`Sei in "${ws.name}" — tocca il nome in alto per cambiare spazio.`);
  else if(reason==='switch') toast(`Passato a "${ws.name}".`);
  else if(reason==='created') toast(`Nuovo spazio "${ws.name}" creato.`);
  else if(reason==='joined') toast(`Sei entrato in "${ws.name}".`);
  setTimeout(maybeShowInstallPopup, 1200);
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
  S.weekOffset = 0;
  S.selectedCalendarOverrideId = null;
  S.view='app'; S.tab='presenze';
  S.calendars = []; S.calendarPeriods = []; S.slots = []; S.extraSlots = []; S.attendance = []; S.recurring = []; S.instructors = []; S.cancellations = []; S.absenceRequests = [];
  render();
  await loadCalendars();
  await loadInstructors();
  await refreshWeekData();
  setTimeout(maybeShowInstallPopup, 1200);
}

function guestLogout(){
  localStorage.removeItem('guest_'+S.guest.token);
  location.href = location.pathname;
}

/* ---------------- auth actions ---------------- */

/* Normalizza l'email: le tastiere mobili mettono spesso la maiuscola iniziale
   o uno spazio finale, e l'accesso fallirebbe senza motivo apparente. */
function cleanEmail(email){ return (email||'').trim().toLowerCase(); }

/* Controlli lato client: meglio un messaggio preciso subito che un errore
   generico del server. Ritorna il messaggio d'errore, o '' se va tutto bene. */
function validateCredentials(email, password){
  if(!email) return 'Inserisci la tua email.';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'L\'indirizzo email non sembra valido.';
  if(!password) return 'Inserisci la password.';
  return '';
}

/* Traduce gli errori di Supabase in frasi comprensibili */
function authErrorMessage(error, fallback){
  const msg = ((error && error.message) || '').toLowerCase();
  const status = error && error.status;
  if(!navigator.onLine || msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('network request failed'))
    return 'Nessuna connessione a internet. Riprova quando sei online.';
  if(msg.includes('invalid login credentials')) return 'Email o password non corretti.';
  if(msg.includes('email not confirmed')) return 'Devi prima confermare l\'email: controlla la posta (anche lo spam).';
  if(msg.includes('already registered') || msg.includes('already been registered') || msg.includes('user already'))
    return 'Email già registrata: usa "Accedi".';
  if(msg.includes('password should be at least') || msg.includes('weak password'))
    return 'La password deve avere almeno 6 caratteri.';
  if(status===429 || msg.includes('rate limit') || msg.includes('security purposes') || msg.includes('too many'))
    return 'Troppi tentativi ravvicinati. Aspetta un minuto e riprova.';
  if(msg.includes('invalid email') || msg.includes('unable to validate email'))
    return 'L\'indirizzo email non sembra valido.';
  if(msg.includes('signups not allowed') || msg.includes('signup is disabled'))
    return 'Le registrazioni sono disattivate su questo spazio. Chiedi un codice invito all\'amministratore.';
  return fallback;
}

async function doLogin(email, password){
  if(S.busy) return;                                    // niente doppi invii
  email = cleanEmail(email);
  const bad = validateCredentials(email, password);
  if(bad){ S.authErr = bad; render(); return; }

  S.busy=true; S.authErr=''; S.authMsg=''; render();
  armAuthWatchdog('Accesso lento o interrotto. Controlla la connessione e riprova.');
  let error = null;
  try{
    ({error} = await sb.auth.signInWithPassword({email, password}));
  }catch(err){ error = err; }
  if(error){
    clearAuthWatchdog();
    S.busy=false;
    S.authErr = authErrorMessage(error, 'Accesso non riuscito: controlla email e password.');
    render(); return;
  }
  // Da qui prosegue onAuthEvent → handleSignedIn: teniamo il pulsante su
  // "Attendere..." finché il profilo non è caricato (o scatta il watchdog).
}

/* ---------------- recupero password ----------------
   Il link arriva per email e deve riportare l'utente sull'app: serve perciò
   l'indirizzo pubblico dove Presencer è ospitato. Dentro l'APK location.origin
   è un indirizzo interno al telefono, che in un link non porta da nessuna parte. */
function recoveryRedirectUrl(){
  // APK: il link riapre l'app grazie allo schema dichiarato nel manifest Android.
  if(window.PresencerNative && window.PresencerNative.isNative) return NATIVE_RECOVERY_URL;
  const configured = (window.APP_URL || '').trim();
  if(configured) return configured.replace(/[#?].*$/, '');
  return location.origin + location.pathname;
}

/* Il frammento (la parte dopo #) di un indirizzo, sia esso la pagina corrente
   o l'indirizzo con cui Android ha aperto l'app. */
function hashParams(url){
  const at = (url || '').indexOf('#');
  return new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
}

/* Che cosa porta un ritorno da Supabase: il recupero password, il suo errore,
   o niente che ci riguardi. */
function readAuthLink(params){
  if(params.get('type')==='recovery'){
    return {type:'recovery', accessToken: params.get('access_token'), refreshToken: params.get('refresh_token')};
  }
  const code = (params.get('error_code') || params.get('error') || '').toLowerCase();
  if(!code) return null;
  return {type:'error', message: /expired|otp/.test(code)
    ? 'Il link è scaduto o è già stato usato. Richiedine uno nuovo da "Password dimenticata?".'
    : 'Il link non è valido: richiedine uno nuovo da "Password dimenticata?".'};
}

/* APK: un link esterno ha aperto l'app. Qui i token non li vede supabase-js
   (non c'è nessun frammento nella pagina), quindi la sessione la apriamo noi. */
async function handleAppLink(url){
  const link = readAuthLink(hashParams(url));
  if(!link) return;
  if(link.type==='error'){
    // Chi sta già lavorando non viene buttato fuori per un link scaduto.
    if(S.view==='app'){ toast(link.message); return; }
    recoveryFlow = false;
    S.authTab = 'login'; S.authErr = link.message; S.authMsg = '';
    S.view = 'auth'; render(); return;
  }
  if(!link.accessToken || !link.refreshToken){
    recoveryFlow = false;
    S.authTab = 'reset'; S.authMsg = '';
    S.authErr = 'Il link non è più valido: richiedine uno nuovo.';
    S.view = 'auth'; render(); return;
  }

  recoveryFlow = true;
  S.busy = false; S.authErr = ''; S.authMsg = '';
  S.view = 'loading'; render();
  try{
    const {data, error} = await sb.auth.setSession({access_token: link.accessToken, refresh_token: link.refreshToken});
    if(error) throw error;
    S.session = data.session;
  }catch(err){
    console.error(err);
    recoveryFlow = false;
    S.authTab = 'reset';
    S.authErr = authErrorMessage(err, 'Il link non è più valido: richiedine uno nuovo.');
    S.view = 'auth'; render(); return;
  }
  // setSession fa scattare anche onAuthEvent, che porta qui lo stesso: la
  // schermata si apre una volta sola (enterPasswordRecovery se ne accorge).
  enterPasswordRecovery();
}

/* Chiede a Supabase di spedire il link per reimpostare la password */
async function doResetPassword(email){
  if(S.busy) return;
  email = cleanEmail(email);
  S.authEmail = email;
  if(!email){ S.authErr = 'Inserisci la tua email.'; render(); return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ S.authErr = 'L\'indirizzo email non sembra valido.'; render(); return; }
  const redirectTo = recoveryRedirectUrl();

  S.busy = true; S.authErr = ''; S.authMsg = ''; render();
  let error = null;
  try{
    ({error} = await sb.auth.resetPasswordForEmail(email, {redirectTo}));
  }catch(err){ error = err; }
  S.busy = false;
  if(error){
    S.authErr = authErrorMessage(error, 'Non riesco a inviare l\'email di recupero. Riprova tra poco.');
  } else {
    // Non diciamo se quell'indirizzo esiste davvero: sarebbe un modo comodo per
    // scoprire chi è registrato.
    S.authMsg = 'Se esiste un account con questa email, ti è arrivato il link per scegliere una nuova password. Controlla la posta, anche nello spam.';
  }
  render();
}

/* Siamo tornati dal link: da qui si passa solo per la nuova password */
function enterPasswordRecovery(){
  if(S.view==='newpass') return;
  if(!S.session){
    recoveryFlow = false;
    S.view = 'auth'; S.authTab = 'reset'; S.authMsg = '';
    S.authErr = 'Il link non è più valido: richiedine uno nuovo.';
    render(); return;
  }
  recoveryFlow = true;
  clearAuthWatchdog();
  S.busy = false; S.authErr = ''; S.authMsg = '';
  S.view = 'newpass'; render();
}

/* Salva la nuova password e prosegue dritto dentro l'app: chi è arrivato fin
   qui ha appena dimostrato di leggere la posta di quell'indirizzo. */
async function doSetNewPassword(pass1, pass2){
  if(S.busy) return;
  if(!pass1 || pass1.length < 6){ S.authErr = 'La password deve avere almeno 6 caratteri.'; render(); return; }
  if(pass1 !== pass2){ S.authErr = 'Le due password non coincidono.'; render(); return; }

  S.busy = true; S.authErr = ''; render();
  let error = null;
  try{
    ({error} = await sb.auth.updateUser({password: pass1}));
  }catch(err){ error = err; }
  if(error){
    S.busy = false;
    S.authErr = authErrorMessage(error, 'Non riesco a salvare la nuova password. Il link potrebbe essere scaduto: richiedine uno nuovo.');
    render(); return;
  }
  recoveryFlow = false;
  clearRecoveryHash();
  S.busy = false;
  toast('Password aggiornata.');
  S.view = 'loading'; render();
  armAuthWatchdog('Accesso lento o interrotto. Controlla la connessione e riprova.');
  await handleSignedIn();
}

/* Normalmente il frammento del link lo toglie supabase-js appena l'ha letto.
   Se per qualche motivo resta, un ricaricamento riporterebbe alla schermata
   della nuova password: meglio ripulirlo appena il recupero è concluso. */
function clearRecoveryHash(){
  if(/type=recovery/.test(location.hash || '')) history.replaceState(null, '', location.pathname + location.search);
}

/* Ci ha ripensato: si chiude la sessione temporanea nata dal link */
async function cancelPasswordRecovery(){
  recoveryFlow = false;
  clearRecoveryHash();
  S.busy = false; S.authErr = ''; S.authMsg = '';
  S.authTab = 'login'; S.view = 'auth'; render();
  try{ await sb.auth.signOut(); }catch(e){ console.error(e); }
}

async function doRegisterWorkspace(name, wsName, email, password){
  if(S.busy) return;
  email = cleanEmail(email);
  if(!name){ S.authErr='Inserisci il tuo nome.'; render(); return; }
  if(!wsName){ S.authErr='Dai un nome al tuo spazio.'; render(); return; }
  const bad = validateCredentials(email, password);
  if(bad){ S.authErr = bad; render(); return; }
  if(password.length < 6){ S.authErr='La password deve avere almeno 6 caratteri.'; render(); return; }

  S.busy=true; S.authErr=''; authFlowBusy=true; render();
  armAuthWatchdog('Registrazione lenta o interrotta. Controlla la connessione e riprova.');
  try{
    const {data, error} = await sb.auth.signUp({email, password});
    if(error){ return authFail(authErrorMessage(error, 'Registrazione non riuscita.')); }
    // Con la conferma email attiva, Supabase non segnala le email già usate:
    // restituisce un utente senza identità collegate.
    if(data.user && Array.isArray(data.user.identities) && data.user.identities.length===0){
      S.authTab='login';
      return authFail('Email già registrata: usa "Accedi".');
    }
    if(!data.session){
      S.authTab='login';
      return authFail('Account creato! Conferma la mail e poi accedi. (Per un accesso più semplice, l\'amministratore può disattivare la conferma email nelle impostazioni Supabase.)');
    }
    S.session = data.session;

    const code = genCode(6);
    const {data:ws, error:e2} = await sb.from('workspaces').insert({name: wsName, invite_code: code}).select().single();
    if(e2){ console.error(e2); return authFail(authErrorMessage(e2, 'Account creato, ma non sono riuscito a creare lo spazio. Riprova ad accedere.')); }

    const e3 = await insertProfileWithRetry({user_id: data.session.user.id, workspace_id: ws.id, name, role:'admin'});
    if(e3){ console.error(e3); return authFail(authErrorMessage(e3, 'Spazio creato, ma non sono riuscito a creare il tuo profilo. Accedi e riprova.')); }

    authFlowBusy = false;
    await handleSignedIn();
  }catch(err){
    console.error(err);
    return authFail(authErrorMessage(err, 'Registrazione non riuscita.'));
  }finally{
    authFlowBusy = false;
  }
}

async function doJoin(name, code, email, password){
  if(S.busy) return;
  email = cleanEmail(email);
  if(!name){ S.authErr='Inserisci il tuo nome.'; render(); return; }
  if(!code || !code.trim()){ S.authErr='Inserisci il codice invito.'; render(); return; }
  const bad = validateCredentials(email, password);
  if(bad){ S.authErr = bad; render(); return; }
  if(password.length < 6){ S.authErr='La password deve avere almeno 6 caratteri.'; render(); return; }

  S.busy=true; S.authErr=''; authFlowBusy=true; render();
  armAuthWatchdog('Registrazione lenta o interrotta. Controlla la connessione e riprova.');
  try{
    const {data:ws, error:e1} = await sb.from('workspaces').select('*').eq('invite_code', code.trim().toUpperCase()).maybeSingle();
    if(e1){ console.error(e1); return authFail(authErrorMessage(e1, 'Non riesco a verificare il codice. Riprova.')); }
    if(!ws){ return authFail('Codice invito non valido.'); }

    const {data, error} = await sb.auth.signUp({email, password});
    if(error){
      // Chi ha già un account deve accedere e poi usare il codice dal profilo.
      const m = authErrorMessage(error, 'Registrazione non riuscita.');
      if(m.indexOf('già registrata')>=0){
        S.authTab='login';
        return authFail('Email già registrata: accedi, poi usa il codice invito dal menu in alto per entrare nello spazio.');
      }
      return authFail(m);
    }
    if(data.user && Array.isArray(data.user.identities) && data.user.identities.length===0){
      S.authTab='login';
      return authFail('Email già registrata: accedi, poi usa il codice invito dal menu in alto per entrare nello spazio.');
    }
    if(!data.session){
      S.authTab='login';
      return authFail('Account creato! Conferma la mail e poi accedi.');
    }
    S.session = data.session;

    const e3 = await insertProfileWithRetry({user_id: data.session.user.id, workspace_id: ws.id, name, role:'instructor'});
    if(e3){ console.error(e3); return authFail(authErrorMessage(e3, 'Account creato, ma non sono riuscito a entrare nello spazio. Accedi e riprova con il codice.')); }

    authFlowBusy = false;
    await handleSignedIn();
  }catch(err){
    console.error(err);
    return authFail(authErrorMessage(err, 'Registrazione non riuscita.'));
  }finally{
    authFlowBusy = false;
  }
}

/* Mostra l'errore e rimette la schermata di accesso in uno stato pulito */
function authFail(message){
  clearAuthWatchdog();
  authFlowBusy = false;
  S.busy = false;
  S.authErr = message;
  S.authMsg = '';
  S.view = 'auth';
  render();
}

/* L'inserimento del profilo può fallire per un intoppo di rete proprio mentre
   il token appena creato viene propagato: un secondo tentativo salva la sessione. */
async function insertProfileWithRetry(row){
  let {error} = await sb.from('profiles').insert(row);
  if(!error || error.code==='23505') return null;   // 23505 = profilo già presente
  await new Promise(r=>setTimeout(r, 700));
  ({error} = await sb.from('profiles').insert(row));
  if(error && error.code==='23505') return null;
  return error || null;
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

/* Le foto del telefono pesano diversi MB, possono essere HEIC e su Android a volte
   arrivano senza tipo: le riduciamo a un JPEG quadrato da 512px, leggero e
   leggibile da ogni browser. */
async function shrinkImage(file, size=512){
  const url = URL.createObjectURL(file);
  try{
    const img = await new Promise((ok, ko)=>{ const i = new Image(); i.onload = ()=> ok(i); i.onerror = ko; i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(size, side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = out;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth-side)/2, (img.naturalHeight-side)/2, side, side, 0, 0, out, out);
    return await new Promise(ok=> canvas.toBlob(ok, 'image/jpeg', 0.85));
  }finally{ URL.revokeObjectURL(url); }
}

async function uploadAvatar(file){
  if(file.type && !file.type.startsWith('image/')){ toast('Scegli un\'immagine.'); return; }
  toast('Caricamento foto...');
  let blob = null;
  try{ blob = await shrinkImage(file); }catch(e){ console.warn('Foto non ridimensionata', e); }
  if(!blob){
    // formato che il browser non sa aprire (es. HEIC fuori da Safari)
    toast('Formato immagine non supportato: scegli una foto JPG o PNG.');
    return;
  }
  await refreshSessionIfStale();
  const path = `${S.session.user.id}/avatar.jpg`;
  const {error} = await sb.storage.from('avatars').upload(path, blob, {upsert:true, cacheControl:'3600', contentType:'image/jpeg'});
  if(error){
    console.error('Presencer: caricamento foto', error);
    toast('Errore caricamento foto: '+(error.message||'riprova')+'.');
    return;
  }
  const {data} = sb.storage.from('avatars').getPublicUrl(path);
  const url = data.publicUrl + '?t=' + Date.now();
  const {error:e2} = await sb.from('profiles').update({avatar_url:url}).eq('user_id', S.session.user.id);
  if(e2){ console.error('Presencer: salvataggio foto', e2); toast('Errore salvataggio foto: '+(e2.message||'riprova')+'.'); return; }
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
  if(notificationChannel){
    try{ await sb.removeChannel(notificationChannel); }catch(e){}
    notificationChannel = null;
  }
  await removePushToken();
  // Se il token è già scaduto signOut può fallire: l'uscita deve comunque riuscire.
  try{ await sb.auth.signOut(); }catch(e){ console.error(e); }
  clearAuthWatchdog();
  S.session=null; S.profile=null; S.workspace=null; S.myProfiles=[]; S.myWorkspaces=[];
  recoveryFlow = false;
  S.busy=false; S.authErr=''; S.authMsg=''; S.authTab='login'; S.view='auth'; S.tab='presenze';
  render();
}

/* ---------------- data loaders ---------------- */
async function loadCalendarPeriods(){
  if(!S.workspace){ S.calendarPeriods = []; return; }
  const wsId = S.workspace.id;
  try {
    const {data, error} = await sb.from('calendar_periods').select('*').eq('workspace_id', wsId).order('start_date', {ascending:true});
    if(S.workspace?.id!==wsId) return;
    if(!error && data){
      S.calendarPeriods = data;
    } else {
      S.calendarPeriods = [];
    }
  } catch(e){
    if(S.workspace?.id===wsId) S.calendarPeriods = [];
  }
}

async function loadCalendars(){
  const wsId = S.workspace.id;
  try{
    const data = await checkedRows(sb.from('calendars').select('*').eq('workspace_id', wsId).order('created_at'));
    if(S.workspace?.id!==wsId) return false;
    S.calendars = data;
    await loadCalendarPeriods();
    render();
    return true;
  }catch(error){
    if(S.workspace?.id===wsId) showDataError(error, 'Caricamento calendari');
    return false;
  }
}

async function refreshWeekData(){
  if(S.presenceSaving || !S.workspace) return false;
  const version = ++weekLoadVersion;
  const context = presenceContext();
  const current = ()=> version===weekLoadVersion && context===presenceContext();
  const monday = mondayOf(S.weekOffset);
  const dates = weekDates(monday);
  const from = toISO(dates[0]), to = toISO(dates[6]);
  const calIds = S.calendars.map(c=>c.id);
  const guest = isGuest();
  S.weekLoading = true;
  render();
  try{
    const [slots, extraSlots] = await Promise.all([
      calIds.length ? checkedRows(sb.from('slots').select('*').in('calendar_id', calIds).order('weekday').order('start_time')) : [],
      calIds.length ? checkedRows(sb.from('extra_slots').select('*').in('calendar_id', calIds).gte('date', from).lte('date', to).order('date').order('start_time')) : [],
    ]);
    const slotIds = slots.map(s=>s.id), extraIds = extraSlots.map(s=>s.id);
    const datedRows = (table, column, ids)=> ids.length
      ? checkedRows(sb.from(table).select('*').in(column, ids).gte('date', from).lte('date', to)) : [];
    // Le richieste partono da oggi anche guardando settimane passate: servono
    // anche all'elenco di quelle ancora da decidere.
    const since = from < todayISO() ? from : todayISO();
    const [attendance, extraAttendance, recurring, logs, extraLogs, cancellations, absenceRequests] = await Promise.all([
      datedRows('attendance', 'slot_id', slotIds),
      datedRows('attendance', 'extra_slot_id', extraIds),
      !guest && slotIds.length ? checkedRows(sb.from('recurring_presence').select('*').in('slot_id', slotIds)) : [],
      guest ? [] : datedRows('lesson_logs', 'slot_id', slotIds),
      guest ? [] : datedRows('lesson_logs', 'extra_slot_id', extraIds),
      slotIds.length ? softRows(sb.from('lesson_cancellations').select('*').in('slot_id', slotIds).gte('date', from).lte('date', to)) : [],
      guest ? [] : softRows(sb.from('absence_requests').select('*, slots(label,start_time,end_time), extra_slots(label,start_time,end_time)')
        .eq('workspace_id', S.workspace.id).gte('date', since).order('date')),
    ]);
    if(!current()) return false;
    // Pubblica una fotografia completa: mai una settimana parziale o la risposta
    // tardiva di una settimana/spazio che l'utente ha già lasciato.
    Object.assign(S, {slots, extraSlots, recurring, cancellations, absenceRequests,
      attendance:attendance.concat(extraAttendance), lessonLogs:logs.concat(extraLogs)});
    S.selectedCalendarId = getEffectiveCalendarForWeek(monday);
    S.weekDataContext = context;
    S.weekLoadFailed = false;
    S.presenceNeedsRefresh = false;
    return true;
  }catch(error){
    if(current()){
      S.weekLoadFailed = true;
      showDataError(error, 'Caricamento presenze');
    }
    return false;
  }finally{
    if(version===weekLoadVersion) S.weekLoading = false;
    render();
  }
}

async function loadInstructors(){
  if(!S.workspace) return false;
  const wsId = S.workspace.id;
  const profileId = myProfileId();
  try{
    const data = await checkedRows(sb.from('profiles').select('*').eq('workspace_id', wsId).order('role').order('name'));
    if(S.workspace?.id!==wsId || profileId!==myProfileId()) return false;
    if(!isGuest()){
      const me = data.find(p=>p.id===profileId);
      if(!me) throw {code:'MEMBERSHIP_MISSING'};
      S.profile = me;
      S.myProfiles = S.myProfiles.map(p=>p.id===me.id ? me : p);
      if(!isAdmin() && ['calendari','istruttori'].includes(S.tab)) S.tab='presenze';
    }
    S.instructors = data;
    if(!S.modal) render();
    return true;
  }catch(error){
    if(S.workspace?.id===wsId && profileId===myProfileId()){
      S.presenceNeedsRefresh = true;
      showDataError(error, 'Aggiornamento membri e ruolo');
    }
    return false;
  }
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

// ricorrenza ancora attiva (quella che il pulsante 🔁 accende e spegne)
function activeRecurring(slotId, instructorId){
  return S.recurring.find(r=>r.slot_id===slotId && r.instructor_id===instructorId && !r.ended_on);
}
function isMyRecurring(slotId){ return !isGuest() && !!activeRecurring(slotId, myProfileId()); }

// La ricorrenza vale dalla settimana in cui è stata creata fino a ended_on (escluso):
// non riempie le settimane precedenti, ma resta nello storico per il conteggio ore.
function mondayISOOf(value){
  const d = value ? new Date(value) : new Date();
  return toISO(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay()+6)%7));
}
function recurringCovers(r, dateStr){
  return dateStr >= mondayISOOf(r.created_at) && (!r.ended_on || dateStr < r.ended_on);
}
// stato replicato dalla ricorrenza in quella data ('presente' | 'assente'), o null
function recurringStatusOn(slotId, instructorId, dateStr, recurring=S.recurring){
  const r = recurring.find(x=>x.slot_id===slotId && x.instructor_id===instructorId && recurringCovers(x, dateStr));
  return r ? (r.status || 'presente') : null;
}

// stato "effettivo" per me su uno slot/data: riga esplicita se c'è, altrimenti presenza
// implicita se lo slot è marcato come ricorrente (da questa settimana in poi), altrimenti nessuno stato.
function myAttendanceState(ref, dateStr){
  const row = findMyAttendance(ref, dateStr);
  if(row) return row.status; // 'presente' | 'assente'
  if(ref.slot_id && !isGuest()){
    const rs = recurringStatusOn(ref.slot_id, myProfileId(), dateStr);
    if(rs) return rs==='assente' ? 'ricorrente-assente' : 'ricorrente';
  }
  return null;
}

/* ---------------- registro lezione (lesson logs) ---------------- */
function logsFor(ref, dateStr){
  return S.lessonLogs.filter(l=>{
    const sameSlot = ref.slot_id ? l.slot_id===ref.slot_id : l.extra_slot_id===ref.extra_slot_id;
    return sameSlot && l.date===dateStr;
  }).sort((a,b)=> String(a.created_at).localeCompare(String(b.created_at)));
}
function myLessonLog(ref, dateStr){
  if(isGuest()) return null;
  return logsFor(ref, dateStr).find(l=> l.instructor_id===myProfileId()) || null;
}
function instructorName(id){
  if(S.profile && S.profile.id===id) return S.profile.name;
  const p = S.instructors.find(x=>x.id===id);
  return p ? p.name : 'Istruttore';
}

async function saveLessonLog(ref, dateStr, content){
  content = (content||'').trim();
  const existing = myLessonLog(ref, dateStr);
  if(!content){
    if(existing) await deleteLessonLog(existing.id);
    else closeModal();
    return;
  }
  if(existing){
    const {data, error} = await sb.from('lesson_logs')
      .update({content, updated_at:new Date().toISOString()}).eq('id', existing.id).select().single();
    if(error){ toast('Errore, riprova.'); return; }
    S.lessonLogs = S.lessonLogs.map(l=> l.id===existing.id ? data : l);
    toast('Registro salvato.');
  } else {
    const payload = Object.assign({date:dateStr, content, instructor_id:myProfileId()}, ref);
    const {data, error} = await sb.from('lesson_logs').insert(payload).select().single();
    if(error){ toast('Errore, riprova.'); return; }
    S.lessonLogs.push(data);
    toast('Registro salvato.');
  }
  closeModal();
}

async function deleteLessonLog(logId){
  const {error} = await sb.from('lesson_logs').delete().eq('id', logId);
  if(error){ toast('Errore, riprova.'); return; }
  S.lessonLogs = S.lessonLogs.filter(l=> l.id!==logId);
  toast('Voce eliminata.');
  closeModal();
}

async function setAttendanceStatus(ref, dateStr, status){
  return runPresenceWrite('Salvataggio presenza', async ()=>{
    const existing = findMyAttendance(ref, dateStr);
    if(existing){
      const data = await checkedRow(sb.from('attendance').update({status}).eq('id', existing.id).select());
      return ()=>{ S.attendance = S.attendance.map(a=>a.id===existing.id ? data : a); };
    }
    const payload = Object.assign({date:dateStr, status}, ref,
      isGuest() ? {guest_token:S.guest.token, guest_name:S.guest.name} : {instructor_id:myProfileId()});
    const data = await checkedRow(sb.from('attendance').insert(payload).select());
    return ()=>{ S.attendance.push(data); };
  });
}

async function clearAttendance(ref, dateStr){
  const existing = findMyAttendance(ref, dateStr);
  if(!existing) return;
  return runPresenceWrite('Rimozione presenza', async ()=>{
    await checkedRow(sb.from('attendance').delete().eq('id', existing.id).select('id'));
    return ()=>{ S.attendance = S.attendance.filter(a=>a.id!==existing.id); };
  });
}

// ciclo al tocco: senza ricorrenza → non segnato → presente → assente → non segnato.
// con ricorrenza → presente (implicito) → assente (eccezione) → torna al ricorrente.
async function cycleAttendance(ref, dateStr){
  const state = myAttendanceState(ref, dateStr);
  if(state===null) return setAttendanceStatus(ref, dateStr, 'presente');
  if(state==='presente') return setAttendanceStatus(ref, dateStr, 'assente');
  if(state==='assente') return clearAttendance(ref, dateStr);
  if(state==='ricorrente') return setAttendanceStatus(ref, dateStr, 'assente');       // eccezione: assente questa settimana
  if(state==='ricorrente-assente') return setAttendanceStatus(ref, dateStr, 'presente'); // eccezione: presente questa settimana
}

async function toggleRecurring(ref, slotId, dateStr){
  if(isGuest()) return;
  return runPresenceWrite('Salvataggio ricorrenza', async ()=>{
    const existing = activeRecurring(slotId, myProfileId());
    if(existing){
      const thisMonday = toISO(mondayOf(0));
      // Nata questa settimana: niente storico da conservare, si cancella.
      if(mondayISOOf(existing.created_at) >= thisMonday){
        await checkedRow(sb.from('recurring_presence').delete().eq('id', existing.id).select('id'));
        return ()=>{
          S.recurring = S.recurring.filter(r=>r.id!==existing.id);
          toast('Presenza ricorrente disattivata.');
        };
      }
      // Altrimenti si chiude: le settimane passate restano presenti per il conteggio ore.
      const data = await checkedRow(sb.from('recurring_presence').update({ended_on:thisMonday}).eq('id', existing.id).select());
      return ()=>{
        S.recurring = S.recurring.map(r=>r.id===existing.id ? data : r);
        toast('Presenza ricorrente disattivata da questa settimana.');
      };
    }
    // replica lo stato attualmente impostato su questo orario (presente/assente),
    // di default 'presente' se non ancora segnato.
    const cur = findMyAttendance(ref, dateStr);
    const status = cur ? cur.status : 'presente';
    const data = await checkedRow(sb.from('recurring_presence').insert({slot_id:slotId, instructor_id:myProfileId(), status}).select());
    return ()=>{
      S.recurring.push(data);
      toast('Presenza ricorrente attivata: segnato "'+status+'" ogni settimana su questo orario.');
    };
  });
}

async function addExtraSlot({date, start_time, end_time, label}){
  const effectiveCalId = S.selectedCalendarOverrideId || calendarForDate(date) || (S.calendars.length ? S.calendars[0].id : null);
  const payload = {calendar_id:effectiveCalId, date, start_time, end_time, label: label||'Lezione extra'};
  if(!isGuest()) payload.created_by = myProfileId();
  const {error} = await sb.from('extra_slots').insert(payload);
  if(error){ toast('Errore aggiunta lezione extra.'); return; }
  closeModal();
  await refreshWeekData();
}

async function deleteExtraSlot(id){
  const extra = S.extraSlots.find(row=>row.id===id);
  if(!extra || isGuest() || (!isAdmin() && extra.created_by!==myProfileId())){
    showDataError({code:'42501'}, 'Eliminazione lezione extra');
    return false;
  }
  return runPresenceWrite('Eliminazione lezione extra', async ()=>{
    await checkedRow(sb.from('extra_slots').delete().eq('id', id).select('id'));
    return ()=>{
      S.extraSlots = S.extraSlots.filter(row=>row.id!==id);
      S.attendance = S.attendance.filter(row=>row.extra_slot_id!==id);
      S.lessonLogs = S.lessonLogs.filter(row=>row.extra_slot_id!==id);
    };
  });
}

/* ---------------- ore e compensi ---------------- */
function rateKey(label){ return String(label||'').trim().toLowerCase(); }
function minutesOf(t){ const [h,m] = String(t||'0:0').split(':').map(Number); return h*60+(m||0); }
function datesBetween(from, to){
  const out = [];
  const [y,m,d] = from.split('-').map(Number);
  for(let dt = new Date(y, m-1, d); toISO(dt) <= to; dt.setDate(dt.getDate()+1)) out.push(toISO(dt));
  return out;
}
function round2(n){ return Math.round(n*100)/100; }
function euro(n){ return (n||0).toLocaleString('it-IT', {style:'currency', currency:'EUR'}); }
function fmtHours(h){ return (h||0).toLocaleString('it-IT', {maximumFractionDigits:2}); }

/* Una riga per persona con ore, lezioni e compenso, più il dettaglio di ogni lezione.
   Presente = riga "presente", oppure ricorrenza attiva quel giorno senza eccezione.
   Regole: da solo prende la tariffa piena; in compresenza ognuno prende
   copresence_factor della tariffa; se c'è un maestro caposcuola (e la regola è attiva)
   il compenso va solo ai maestri presenti, gli altri contano le ore ma non il compenso. */
function computePayroll(data, pay, people, calendarFor){
  pay = Object.assign({}, DEFAULT_PAY, pay||{});
  const byKey = new Map();
  const person = (key, name, grade)=>{
    if(!byKey.has(key)) byKey.set(key, {key, name, grade, hours:0, paidHours:0, amount:0, lessons:0, entries:[]});
    return byKey.get(key);
  };
  people.forEach(p=> person(p.id, p.name, p.grade||'istruttore'));
  datesBetween(data.from, data.to).forEach(dateStr=>{
    const [y,m,d] = dateStr.split('-').map(Number);
    const wd = (new Date(y, m-1, d).getDay()+6)%7;
    const calId = calendarFor(dateStr);
    const lessons = data.slots
      .filter(sl=> sl.calendar_id===calId && sl.weekday===wd && !data.cancellations.some(c=>c.slot_id===sl.id && c.date===dateStr))
      .map(sl=>({row:sl, ref:{slot_id:sl.id}}))
      .concat(data.extras.filter(e=> e.date===dateStr).map(e=>({row:e, ref:{extra_slot_id:e.id}})));
    lessons.forEach(({row, ref})=>{
      const marks = data.attendance.filter(a=> a.date===dateStr && sameLesson(a, ref));
      const present = [];
      marks.forEach(a=>{
        if(a.status!=='presente') return;
        if(a.instructor_id) present.push(person(a.instructor_id, 'Membro rimosso', 'istruttore'));
        else present.push(person('g:'+a.guest_token, (a.guest_name||'Ospite')+' (ospite)', 'istruttore'));
      });
      if(ref.slot_id){
        const seen = new Set(marks.map(a=>a.instructor_id).filter(Boolean));
        data.recurring.forEach(r=>{
          if(r.slot_id!==ref.slot_id || seen.has(r.instructor_id) || !byKey.has(r.instructor_id)) return;
          if(recurringStatusOn(ref.slot_id, r.instructor_id, dateStr, data.recurring)!=='presente') return;
          seen.add(r.instructor_id);
          present.push(byKey.get(r.instructor_id));
        });
      }
      if(!present.length) return;
      const hours = Math.max(0, minutesOf(row.end_time) - minutesOf(row.start_time))/60;
      const custom = pay.rates[rateKey(row.label)];
      const rate = custom!=null && custom!=='' ? Number(custom) : Number(pay.default_rate)||0;
      const masters = pay.master_takes_all ? present.filter(p=> p.grade==='maestro') : [];
      const paid = masters.length ? masters : present;
      const share = paid.length>1 ? Number(pay.copresence_factor) : 1;
      const note = masters.length && present.length>masters.length ? 'con maestro caposcuola'
        : paid.length>1 ? `compresenza (${paid.length})` : '';
      present.forEach(p=>{
        const isPaid = paid.includes(p);
        const amount = isPaid ? round2(rate*hours*share) : 0;
        p.hours += hours; p.lessons++; p.amount = round2(p.amount+amount);
        if(isPaid) p.paidHours += hours;
        p.entries.push({date:dateStr, label:row.label, start:row.start_time, end:row.end_time, hours, rate, amount, note});
      });
    });
  });
  return Array.from(byKey.values()).sort((a,b)=> a.name.localeCompare(b.name));
}

function reportRange(){
  if(S.reportMode==='custom' && S.reportFrom && S.reportTo) return {from:S.reportFrom, to:S.reportTo};
  const anchor = S.reportFrom ? S.reportFrom.split('-').map(Number) : null;
  const base = anchor ? new Date(anchor[0], anchor[1]-1, anchor[2]) : new Date();
  if(S.reportMode==='week'){
    const mon = new Date(base.getFullYear(), base.getMonth(), base.getDate()-(base.getDay()+6)%7);
    return {from:toISO(mon), to:toISO(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate()+6))};
  }
  return {from:toISO(new Date(base.getFullYear(), base.getMonth(), 1)), to:toISO(new Date(base.getFullYear(), base.getMonth()+1, 0))};
}
function shiftReport(dir){
  const {from} = reportRange();
  const [y,m,d] = from.split('-').map(Number);
  const next = S.reportMode==='week' ? new Date(y, m-1, d+7*dir) : new Date(y, m-1+dir, 1);
  S.reportFrom = toISO(next);
  loadReport();
}

async function loadReport(){
  if(!S.workspace || isGuest()) return;
  const wsId = S.workspace.id;
  const {from, to} = reportRange();
  const key = [wsId, from, to].join('|');
  S.reportLoading = true; render();
  try{
    if(!S.instructors.length) await loadInstructors();
    const calIds = S.calendars.map(c=>c.id);
    const [slots, extras, settings] = await Promise.all([
      calIds.length ? checkedRows(sb.from('slots').select('*').in('calendar_id', calIds)) : [],
      calIds.length ? checkedRows(sb.from('extra_slots').select('*').in('calendar_id', calIds).gte('date', from).lte('date', to)) : [],
      softRows(sb.from('pay_settings').select('*').eq('workspace_id', wsId)),
    ]);
    const slotIds = slots.map(x=>x.id), extraIds = extras.map(x=>x.id);
    const dated = (table, column, ids)=> ids.length ? softRows(sb.from(table).select('*').in(column, ids).gte('date', from).lte('date', to)) : [];
    const [att, extraAtt, recurring, cancellations] = await Promise.all([
      dated('attendance', 'slot_id', slotIds),
      dated('attendance', 'extra_slot_id', extraIds),
      slotIds.length ? checkedRows(sb.from('recurring_presence').select('*').in('slot_id', slotIds)) : [],
      dated('lesson_cancellations', 'slot_id', slotIds),
    ]);
    if(S.workspace?.id!==wsId || key!==[wsId, ...Object.values(reportRange())].join('|')) return;
    S.paySettings = Object.assign({}, DEFAULT_PAY, settings[0]||{});
    S.reportData = {from, to, slots, extras, attendance:att.concat(extraAtt), recurring, cancellations};
  }catch(error){
    if(S.workspace?.id===wsId) showDataError(error, 'Caricamento ore');
  }finally{
    S.reportLoading = false; render();
  }
}

async function savePaySettings(values){
  if(!isAdmin()) return;
  try{
    const row = await checkedRow(sb.from('pay_settings').upsert(Object.assign(
      {workspace_id:S.workspace.id, updated_at:new Date().toISOString()}, values), {onConflict:'workspace_id'}).select());
    S.paySettings = Object.assign({}, DEFAULT_PAY, row);
    toast('Regole compensi salvate.');
    closeModal();
  }catch(error){ showDataError(error, 'Salvataggio regole compensi'); closeModal(); }
}

function reportCsv(rows, from, to){
  const cell = v=> `"${String(v).replace(/"/g,'""')}"`;
  const num = n=> String(round2(n)).replace('.', ',');
  const lines = [['Persona','Data','Lezione','Inizio','Fine','Ore','Tariffa €/h','Compenso €','Nota'].map(cell).join(';')];
  rows.forEach(p=> p.entries.forEach(e=> lines.push([p.name, e.date, e.label, fmtHM(e.start), fmtHM(e.end), num(e.hours), num(e.rate), num(e.amount), e.note].map(cell).join(';'))));
  rows.forEach(p=> lines.push([p.name+' TOTALE', from+' / '+to, '', '', '', num(p.hours), '', num(p.amount), p.lessons+' lezioni'].map(cell).join(';')));
  // BOM: senza, Excel apre gli accenti come caratteri strani
  return '\ufeff' + lines.join('\r\n');
}

/* ---------------- lezione annullata in una data (admin) ---------------- */
function cancellationFor(slotId, dateStr){
  return S.cancellations.find(c=>c.slot_id===slotId && c.date===dateStr) || null;
}

// Toglie la lezione settimanale solo in quella data; se richiesto mette al suo
// posto una lezione extra, anche con orario e durata diversi.
async function cancelLesson(slotId, dateStr, reason, replacement){
  if(!isAdmin()) return;
  if(replacement && (!replacement.start_time || !replacement.end_time || replacement.end_time<=replacement.start_time)){
    return toast('Controlla gli orari della lezione sostitutiva.');
  }
  const ok = await runPresenceWrite('Annullamento lezione', async ()=>{
    const row = await checkedRow(sb.from('lesson_cancellations')
      .insert({slot_id:slotId, date:dateStr, reason:reason||null, created_by:myProfileId()}).select());
    let extra = null;
    if(replacement){
      const slot = S.slots.find(x=>x.id===slotId);
      extra = await checkedRow(sb.from('extra_slots').insert({
        calendar_id: slot ? slot.calendar_id : calendarForDate(dateStr), date:replacement.date || dateStr,
        start_time:replacement.start_time, end_time:replacement.end_time,
        label:replacement.label || (slot ? slot.label : 'Lezione extra'), created_by:myProfileId(),
      }).select());
    }
    return ()=>{
      S.cancellations.push(row);
      if(extra && extra.date>=toISO(mondayOf(S.weekOffset)) && extra.date<=toISO(weekDates(mondayOf(S.weekOffset))[6])) S.extraSlots.push(extra);
      toast(extra ? 'Lezione annullata e sostituita.' : 'Lezione annullata.');
    };
  });
  if(ok) closeModal();
}

async function restoreLesson(cancellationId){
  if(!isAdmin()) return;
  await runPresenceWrite('Ripristino lezione', async ()=>{
    await checkedRow(sb.from('lesson_cancellations').delete().eq('id', cancellationId).select('id'));
    return ()=>{ S.cancellations = S.cancellations.filter(c=>c.id!==cancellationId); toast('Lezione ripristinata.'); };
  });
}

/* ---------------- richieste di assenza ---------------- */
function sameLesson(row, ref){ return ref.slot_id ? row.slot_id===ref.slot_id : row.extra_slot_id===ref.extra_slot_id; }
function myAbsenceRequest(ref, dateStr){
  if(isGuest()) return null;
  // la più recente: dopo un rifiuto se ne può fare un'altra
  return S.absenceRequests.filter(r=> sameLesson(r, ref) && r.date===dateStr && r.instructor_id===myProfileId())
    .sort((a,b)=> String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}
function absenceLesson(r){
  const l = r.slots || r.extra_slots || S.slots.find(x=>x.id===r.slot_id) || S.extraSlots.find(x=>x.id===r.extra_slot_id) || {};
  return `${l.label || 'Lezione'}${l.start_time ? ' '+fmtHM(l.start_time) : ''}`;
}

async function requestAbsence(ref, dateStr, reason){
  if(isGuest()) return;
  const ok = await runPresenceWrite('Richiesta di assenza', async ()=>{
    const row = await checkedRow(sb.from('absence_requests').insert(Object.assign(
      {workspace_id:S.workspace.id, instructor_id:myProfileId(), date:dateStr, reason:reason||null}, ref))
      .select('*, slots(label,start_time,end_time), extra_slots(label,start_time,end_time)'));
    return ()=>{ S.absenceRequests.push(row); toast('Richiesta inviata: tutti riceveranno un avviso.'); };
  });
  if(ok) closeModal();
}

async function decideAbsence(id, status){
  if(!isAdmin()) return;
  const ok = await runPresenceWrite(status==='approvata' ? 'Approvazione assenza' : 'Rifiuto assenza', async ()=>{
    const row = await checkedRow(sb.from('absence_requests')
      .update({status, decided_by:myProfileId(), decided_at:new Date().toISOString()}).eq('id', id)
      .select('*, slots(label,start_time,end_time), extra_slots(label,start_time,end_time)'));
    return ()=>{ S.absenceRequests = S.absenceRequests.map(r=>r.id===id ? row : r); };
  });
  // approvata: il database ha segnato l'assenza, la rileggiamo
  if(ok && status==='approvata') await refreshWeekData();
}

async function withdrawAbsence(id){
  const ok = await runPresenceWrite('Ritiro richiesta di assenza', async ()=>{
    await checkedRow(sb.from('absence_requests').delete().eq('id', id).select('id'));
    return ()=>{ S.absenceRequests = S.absenceRequests.filter(r=>r.id!==id); toast('Richiesta ritirata.'); };
  });
  if(ok) closeModal();
}

/* ---------------- calendar/slot management (admin) ---------------- */
async function createCalendar(name, period){
  const {data, error} = await sb.from('calendars').insert({workspace_id:S.workspace.id, name, period}).select().single();
  if(error){ toast('Errore creazione calendario.'); return; }
  closeModal();
  await loadCalendars();
  if(S.calendars.length === 1){
    await setActiveCalendar(data.id);
  } else {
    toast(`Calendario "${name}" creato.`);
    await refreshWeekData();
  }
}

async function setActiveCalendar(id){
  const today = todayISO();
  // 1. Aggiorna workspace per retro-compatibilità
  await sb.from('workspaces').update({active_calendar_id:id, scheduled_calendar_id:null, scheduled_calendar_date:null}).eq('id', S.workspace.id);
  S.workspace.active_calendar_id = id;
  S.workspace.scheduled_calendar_id = null;
  S.workspace.scheduled_calendar_date = null;

  // 2. Inserisci o aggiorna il periodo in calendar_periods
  try {
    const existing = (S.calendarPeriods||[]).find(p=>p.start_date === today);
    if(existing){
      await sb.from('calendar_periods').update({calendar_id:id}).eq('id', existing.id);
    } else {
      await sb.from('calendar_periods').insert({workspace_id:S.workspace.id, calendar_id:id, start_date:today});
    }
  } catch(e){}

  await loadCalendarPeriods();
  toast('Calendario impostato come attivo da oggi.');
  await refreshWeekData();
}

async function scheduleCalendarChange(calendarId, date){
  if(!calendarId || !date){ toast('Scegli calendario e data.'); return; }
  const today = todayISO();
  if(date <= today){
    await setActiveCalendar(calendarId);
    closeModal();
    return;
  }

  // 1. Aggiorna campi workspace
  const {error} = await sb.from('workspaces').update({scheduled_calendar_id:calendarId, scheduled_calendar_date:date}).eq('id', S.workspace.id);
  if(error){ toast('Errore programmazione.'); return; }
  S.workspace.scheduled_calendar_id = calendarId;
  S.workspace.scheduled_calendar_date = date;

  // 2. Inserisci o aggiorna in calendar_periods
  try {
    const existing = (S.calendarPeriods||[]).find(p=>p.start_date === date);
    if(existing){
      await sb.from('calendar_periods').update({calendar_id:calendarId}).eq('id', existing.id);
    } else {
      await sb.from('calendar_periods').insert({workspace_id:S.workspace.id, calendar_id:calendarId, start_date:date});
    }
  } catch(e){}

  await loadCalendarPeriods();
  closeModal();
  toast('Cambio calendario programmato.');
  await refreshWeekData();
}

async function cancelScheduledCalendarChange(){
  const {error} = await sb.from('workspaces').update({scheduled_calendar_id:null, scheduled_calendar_date:null}).eq('id', S.workspace.id);
  if(error){ toast('Errore.'); return; }
  S.workspace.scheduled_calendar_id = null;
  S.workspace.scheduled_calendar_date = null;

  try {
    const today = todayISO();
    await sb.from('calendar_periods').delete().eq('workspace_id', S.workspace.id).gt('start_date', today);
  } catch(e){}

  await loadCalendarPeriods();
  toast('Programmazione annullata.');
  await refreshWeekData();
}

async function applyScheduledCalendarIfDue(){
  const ws = S.workspace;
  if(!ws) return;
  const today = todayISO();

  if(ws.scheduled_calendar_id && ws.scheduled_calendar_date && ws.scheduled_calendar_date <= today){
    const targetId = ws.scheduled_calendar_id;
    await sb.from('workspaces').update({
      active_calendar_id: targetId,
      scheduled_calendar_id: null,
      scheduled_calendar_date: null
    }).eq('id', ws.id);
    ws.active_calendar_id = targetId;
    ws.scheduled_calendar_id = null;
    ws.scheduled_calendar_date = null;
  }
  await loadCalendarPeriods();
}

async function duplicateCalendar(sourceCalId, newName, newPeriod){
  if(!newName || !newName.trim()){ toast('Inserisci un nome per il nuovo calendario.'); return; }
  newName = newName.trim();
  newPeriod = newPeriod || 'personalizzato';

  const {data:newCal, error:e1} = await sb.from('calendars')
    .insert({workspace_id:S.workspace.id, name:newName, period:newPeriod})
    .select().single();
  if(e1 || !newCal){ toast('Errore duplicazione calendario.'); return; }

  const {data:srcSlots} = await sb.from('slots').select('*').eq('calendar_id', sourceCalId);
  if(srcSlots && srcSlots.length > 0){
    const toInsert = srcSlots.map(s => ({
      calendar_id: newCal.id,
      weekday: s.weekday,
      start_time: s.start_time,
      end_time: s.end_time,
      label: s.label
    }));
    await sb.from('slots').insert(toInsert);
  }

  closeModal();
  await loadCalendars();
  await refreshWeekData();
  toast(`Calendario "${newName}" duplicato con successo (${srcSlots ? srcSlots.length : 0} orari copiati).`);
  openCalendarEditor(newCal);
}

async function deleteCalendar(id){
  const {error} = await sb.from('calendars').delete().eq('id', id);
  if(error){ toast('Errore eliminazione calendario.'); return; }
  if(S.selectedCalendarOverrideId===id) S.selectedCalendarOverrideId = null;
  await loadCalendars();
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
  const modal = S.modal;
  if(modal) modal.loadingSlots = true;
  const {data} = await sb.from('slots').select('*').eq('calendar_id', calendarId).order('weekday').order('start_time');
  if(S.modal !== modal) return;   // modale gia' chiuso: non sovrascrivere lo stato corrente
  if(modal){ modal.editSlots = data || []; modal.loadingSlots = false; }
  render();                       // gli orari sono in pagina: il resto arriva dopo
  await refreshWeekData();        // settimana e presenze si aggiornano senza bloccare il modale
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

/* Account senza profilo (registrazione interrotta): entra con un codice invito */
async function joinWorkspaceAfterOrphan(personName, code){
  if(!personName || !code){ toast('Inserisci nome e codice.'); return; }
  const {data:ws, error} = await sb.from('workspaces').select('*').eq('invite_code', code.trim().toUpperCase()).maybeSingle();
  if(error || !ws){ toast('Codice invito non valido.'); return; }
  const e2 = await insertProfileWithRetry({user_id:S.session.user.id, workspace_id:ws.id, name:personName, role:'instructor'});
  if(e2){ toast('Errore creazione profilo.'); return; }
  const {data:prof, error:e3} = await sb.from('profiles').select('*').eq('user_id', S.session.user.id).eq('workspace_id', ws.id).single();
  if(e3){ toast('Errore lettura profilo.'); return; }
  S.myProfiles = [prof];
  S.myWorkspaces = [{id:ws.id, name:ws.name}];
  await activateProfile(prof, 'joined');
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
  if(!isAdmin() || !['admin','instructor'].includes(role)) return;
  const wsId = S.workspace.id;
  try{
    await checkedRow(sb.from('profiles').update({role}).eq('id', id).eq('workspace_id', wsId).select());
    if(S.workspace?.id!==wsId) return;
    toast(role==='admin' ? 'Ora è amministratore.' : 'Ora è istruttore.');
    await loadInstructors();
  }catch(error){
    if(S.workspace?.id===wsId) showDataError(error, 'Cambio ruolo');
  }
}

async function setInstructorGrade(id, grade){
  if(!isAdmin() || !GRADE_LABEL[grade]) return;
  const wsId = S.workspace.id;
  try{
    await checkedRow(sb.from('profiles').update({grade}).eq('id', id).eq('workspace_id', wsId).select());
    if(S.workspace?.id!==wsId) return;
    toast('Grado aggiornato: '+GRADE_LABEL[grade]+'.');
    await loadInstructors();
  }catch(error){
    if(S.workspace?.id===wsId) showDataError(error, 'Cambio grado');
  }
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
let savedScrollY = 0;
/* ---------------- backup dello spazio ----------------
   Salva su file tutto cio' che appartiene allo spazio: calendari, orari, lezioni
   extra, presenze, ricorrenze, registri e accessi rapidi. Le persone NON sono
   ricreabili (sono legate agli account di accesso), quindi finiscono nel file solo
   come riferimento e in fase di ripristino le presenze vengono riagganciate ai
   membri attuali: stesso id, oppure stesso nome. */
const BACKUP_FORMAT = 'presencer-backup';

async function softRows(query){
  // Alcune tabelle esistono solo se la migrazione e' stata eseguita: la loro
  // assenza non deve far fallire l'intero backup.
  try{ return await checkedRows(query); }
  catch(error){
    if(error && (error.code==='42P01' || error.code==='PGRST205')) return [];
    throw error;
  }
}

async function buildBackup(){
  const wsId = S.workspace.id;
  const calendars = await checkedRows(sb.from('calendars').select('*').eq('workspace_id', wsId).order('created_at'));
  const calIds = calendars.map(c=>c.id);
  const profiles = await checkedRows(sb.from('profiles').select('*').eq('workspace_id', wsId));
  const calendarPeriods = await softRows(sb.from('calendar_periods').select('*').eq('workspace_id', wsId));
  const guestLinks = await softRows(sb.from('guest_links').select('*').eq('workspace_id', wsId));
  const slots = calIds.length ? await checkedRows(sb.from('slots').select('*').in('calendar_id', calIds)) : [];
  const extraSlots = calIds.length ? await checkedRows(sb.from('extra_slots').select('*').in('calendar_id', calIds)) : [];
  const slotIds = slots.map(s=>s.id), extraIds = extraSlots.map(s=>s.id);
  const bySlot = (table, column, ids)=> ids.length ? softRows(sb.from(table).select('*').in(column, ids)) : [];
  const attendance = (await bySlot('attendance','slot_id',slotIds)).concat(await bySlot('attendance','extra_slot_id',extraIds));
  const recurring = await bySlot('recurring_presence','slot_id',slotIds);
  const lessonLogs = (await bySlot('lesson_logs','slot_id',slotIds)).concat(await bySlot('lesson_logs','extra_slot_id',extraIds));
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      id: wsId, name: S.workspace.name,
      active_calendar_id: S.workspace.active_calendar_id || null,
      scheduled_calendar_id: S.workspace.scheduled_calendar_id || null,
      scheduled_calendar_date: S.workspace.scheduled_calendar_date || null,
    },
    profiles, calendars, calendarPeriods, slots, extraSlots, guestLinks, attendance, recurring, lessonLogs,
  };
}

function backupCounts(b){
  return [
    ['Calendari', (b.calendars||[]).length],
    ['Orari settimanali', (b.slots||[]).length],
    ['Lezioni extra', (b.extraSlots||[]).length],
    ['Presenze', (b.attendance||[]).length],
    ['Presenze ricorrenti', (b.recurring||[]).length],
    ['Registri lezione', (b.lessonLogs||[]).length],
    ['Accessi rapidi', (b.guestLinks||[]).length],
    ['Membri (solo riferimento)', (b.profiles||[]).length],
  ];
}

function backupCountsHtml(counts){
  return '<div class="col" style="gap:4px;margin:12px 0">' + counts
    .map(([k,v])=> '<div class="row between"><span class="hint">'+esc(k)+'</span><b>'+v+'</b></div>')
    .join('') + '</div>';
}

function downloadText(filename, text, type='application/json'){
  try{
    const url = URL.createObjectURL(new Blob([text], {type}));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 5000);
    return true;
  }catch(e){ return false; }
}

async function exportBackup(){
  if(S.backupBusy || !S.workspace) return;
  S.backupBusy = true; S.dataError = null; render();
  try{
    const backup = await buildBackup();
    const text = JSON.stringify(backup, null, 2);
    const slug = (S.workspace.name||'spazio').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'spazio';
    const name = 'presencer-' + slug + '-' + todayISO() + '.json';
    downloadText(name, text);
    S.modal = {type:'backup-done', name, text, counts: backupCounts(backup)};
    lockScroll();
  }catch(error){
    showDataError(error, 'Esportazione backup');
  }finally{
    S.backupBusy = false; render();
  }
}

function pickBackupFile(){
  if(S.backupBusy) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async ()=>{
    const file = input.files && input.files[0];
    if(!file) return;
    let backup;
    try{ backup = JSON.parse(await file.text()); }
    catch(e){ toast('File non leggibile: non e\u2019 un JSON valido.'); return; }
    if(!backup || backup.format!==BACKUP_FORMAT){ toast('Questo file non e\u2019 un backup di Presencer.'); return; }
    openModal({type:'backup-restore', backup, counts: backupCounts(backup)});
  };
  input.click();
}

async function restoreBackup(backup){
  if(S.backupBusy || !S.workspace) return;
  const wsId = S.workspace.id;
  S.backupBusy = true; S.dataError = null; render();
  let skipped = 0;
  try{
    // Le persone restano quelle di adesso: dal backup recuperiamo solo il legame.
    const current = new Set(S.instructors.map(p=>p.id));
    const byName = new Map(S.instructors.map(p=>[(p.name||'').trim().toLowerCase(), p.id]));
    const oldProfiles = new Map((backup.profiles||[]).map(p=>[p.id, p]));
    const mapProfile = id=>{
      if(!id) return null;
      if(current.has(id)) return id;
      const old = oldProfiles.get(id);
      return (old && byName.get((old.name||'').trim().toLowerCase())) || null;
    };
    const insertAll = async (table, rows)=>{
      for(let i=0; i<rows.length; i+=400){
        const {error} = await sb.from(table).insert(rows.slice(i, i+400));
        if(error) throw error;
      }
    };

    // Cancellare i calendari porta via a cascata orari, lezioni extra, presenze,
    // ricorrenze e registri: non serve svuotarli uno per uno.
    let del = await sb.from('calendars').delete().eq('workspace_id', wsId);
    if(del.error) throw del.error;
    del = await sb.from('guest_links').delete().eq('workspace_id', wsId);
    if(del.error && del.error.code!=='42P01' && del.error.code!=='PGRST205') throw del.error;

    const calendars = (backup.calendars||[]).map(c=>({id:c.id, workspace_id:wsId, name:c.name, period:c.period}));
    await insertAll('calendars', calendars);
    const calIds = new Set(calendars.map(c=>c.id));

    await insertAll('calendar_periods', (backup.calendarPeriods||[])
      .filter(p=> calIds.has(p.calendar_id))
      .map(p=>({id:p.id, workspace_id:wsId, calendar_id:p.calendar_id, start_date:p.start_date})));

    const slots = (backup.slots||[]).filter(s=> calIds.has(s.calendar_id))
      .map(s=>({id:s.id, calendar_id:s.calendar_id, weekday:s.weekday, start_time:s.start_time, end_time:s.end_time, label:s.label}));
    await insertAll('slots', slots);
    const slotIds = new Set(slots.map(s=>s.id));

    const extras = (backup.extraSlots||[]).filter(e=> calIds.has(e.calendar_id))
      .map(e=>({id:e.id, calendar_id:e.calendar_id, date:e.date, start_time:e.start_time, end_time:e.end_time, label:e.label, created_by:mapProfile(e.created_by)}));
    await insertAll('extra_slots', extras);
    const extraIds = new Set(extras.map(e=>e.id));

    const links = (backup.guestLinks||[]).map(g=>({id:g.id, workspace_id:wsId, token:g.token, label:g.label, expires_at:g.expires_at, created_by:mapProfile(g.created_by)}));
    await insertAll('guest_links', links);
    const tokens = new Set(links.map(g=>g.token));

    const refOk = r=> r.slot_id ? slotIds.has(r.slot_id) : extraIds.has(r.extra_slot_id);
    const seen = new Set();
    const unique = key=>{ if(seen.has(key)) return false; seen.add(key); return true; };

    const attendance = [];
    (backup.attendance||[]).forEach(a=>{
      if(!refOk(a)){ skipped++; return; }
      const who = a.guest_token ? (tokens.has(a.guest_token) ? a.guest_token : null) : mapProfile(a.instructor_id);
      if(!who){ skipped++; return; }
      if(!unique(['a', a.slot_id||'', a.extra_slot_id||'', who, a.date].join('|'))){ skipped++; return; }
      const row = {id:a.id, slot_id:a.slot_id||null, extra_slot_id:a.extra_slot_id||null, date:a.date, status:a.status, note:a.note||null};
      if(a.guest_token){ row.guest_token = who; row.guest_name = a.guest_name||null; }
      else row.instructor_id = who;
      attendance.push(row);
    });
    await insertAll('attendance', attendance);

    const recurring = [];
    (backup.recurring||[]).forEach(r=>{
      if(!slotIds.has(r.slot_id)){ skipped++; return; }
      const who = mapProfile(r.instructor_id);
      if(!who){ skipped++; return; }
      if(!unique(['r', r.slot_id, who, r.ended_on||'attiva'].join('|'))){ skipped++; return; }
      const row = {id:r.id, slot_id:r.slot_id, instructor_id:who, status:r.status, created_at:r.created_at};
      if(r.ended_on) row.ended_on = r.ended_on;
      recurring.push(row);
    });
    await insertAll('recurring_presence', recurring);

    const logs = [];
    (backup.lessonLogs||[]).forEach(l=>{
      if(!refOk(l)){ skipped++; return; }
      const who = mapProfile(l.instructor_id);
      if(!who){ skipped++; return; }
      if(!unique(['l', l.slot_id||'', l.extra_slot_id||'', who, l.date].join('|'))){ skipped++; return; }
      logs.push({id:l.id, slot_id:l.slot_id||null, extra_slot_id:l.extra_slot_id||null, instructor_id:who, date:l.date, content:l.content});
    });
    if(logs.length) await insertAll('lesson_logs', logs);

    // Nome e codice invito dello spazio restano quelli attuali: si ripristina il
    // contenuto, non l'identita' dello spazio.
    const w = backup.workspace || {};
    const upd = await sb.from('workspaces').update({
      active_calendar_id: calIds.has(w.active_calendar_id) ? w.active_calendar_id : null,
      scheduled_calendar_id: calIds.has(w.scheduled_calendar_id) ? w.scheduled_calendar_id : null,
      scheduled_calendar_date: calIds.has(w.scheduled_calendar_id) ? (w.scheduled_calendar_date||null) : null,
    }).eq('id', wsId).select().maybeSingle();
    if(upd.error) throw upd.error;
    if(upd.data) S.workspace = upd.data;

    closeModal();
    await loadCalendars();
    await refreshWeekData();
    await loadGuestLinks();
    toast(skipped ? 'Backup ripristinato. ' + skipped + ' righe saltate.' : 'Backup ripristinato.');
  }catch(error){
    showDataError(error, 'Ripristino backup');
    toast('Ripristino interrotto. Controlla il messaggio in cima alla pagina.');
  }finally{
    S.backupBusy = false; render();
  }
}

function lockScroll(){
  if(document.body.classList.contains('modal-open')) return; // già bloccato
  savedScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.style.top = `-${savedScrollY}px`;
  document.body.classList.add('modal-open');
}
function unlockScroll(){
  if(!document.body.classList.contains('modal-open')) return;
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  window.scrollTo(0, savedScrollY);
}
function openModal(m){ S.modal = m; lockScroll(); render(); }
function closeModal(){ S.modal = null; animatedModal = null; unlockScroll(); render(); }

/* ================= RENDER ================= */
/* La pagina si ricostruisce per intero a ogni aggiornamento. Farlo "a caldo" la fa
   lampeggiare: lo scorrimento salta, il testo che stai scrivendo sparisce, i popup
   ripartono con l'animazione. Qui l'albero nuovo si monta staccato ed entra in un
   colpo solo, e cio' che appartiene a te (fuoco, cursore, scorrimento) torna dov'era.
   Piu' chiamate ravvicinate a render() diventano un solo aggiornamento. */
let renderScheduled = false;
let animatedModal = null;
function render(){
  if(renderScheduled) return;
  renderScheduled = true;
  Promise.resolve().then(()=>{ renderScheduled = false; renderNow(); });
}

function captureUi(){
  const ui = {pageY: window.scrollY || window.pageYOffset || 0, scroll: new Map(), focus: null};
  APP.querySelectorAll('[data-keep-scroll]').forEach(el=>{
    if(el.scrollLeft || el.scrollTop) ui.scroll.set(el.getAttribute('data-keep-scroll'), [el.scrollLeft, el.scrollTop]);
  });
  const a = document.activeElement;
  if(a && a.id && APP.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)){
    ui.focus = {id:a.id, value:a.value, start:null, end:null};
    try{ ui.focus.start = a.selectionStart; ui.focus.end = a.selectionEnd; }catch(e){}
  }
  return ui;
}

function restoreUi(ui){
  ui.scroll.forEach((pos, key)=>{
    const el = APP.querySelector('[data-keep-scroll="'+key+'"]');
    if(el){ el.scrollLeft = pos[0]; el.scrollTop = pos[1]; }
  });
  const f = ui.focus;
  if(f){
    const el = document.getElementById(f.id);
    // Solo il campo che stavi usando conserva quello che avevi scritto: gli altri
    // devono restare liberi di cambiare quando cambiano i dati.
    if(el && APP.contains(el)){
      if(el.value !== f.value) el.value = f.value;
      el.focus({preventScroll:true});
      if(f.start!=null){ try{ el.setSelectionRange(f.start, f.end); }catch(e){} }
    }
  }
  if(!document.body.classList.contains('modal-open') && (window.scrollY||0) !== ui.pageY) window.scrollTo(0, ui.pageY);
}

function renderNow(){
  const ui = captureUi();
  const next = document.createDocumentFragment();
  if(S.view==='loading'){ const sp = document.createElement('div'); sp.className = 'spinner'; next.appendChild(sp); }
  else if(S.view==='setup') next.appendChild(renderSetup());
  else if(S.view==='guestname') next.appendChild(renderGuestName());
  else if(S.view==='auth') next.appendChild(renderAuth());
  else if(S.view==='reconnect') next.appendChild(renderReconnect());
  else if(S.view==='no-workspace') next.appendChild(renderNoWorkspace());
  else if(S.view==='newpass') next.appendChild(renderNewPassword());
  else if(S.view==='app') next.appendChild(renderShell());
  // Uno scambio solo: la pagina non passa mai per lo stato vuoto.
  if(APP.replaceChildren) APP.replaceChildren(next);
  else { APP.innerHTML = ''; APP.appendChild(next); }
  restoreUi(ui);
}

/* Sei ancora dentro: è solo la rete che manca. Nessun logout, solo un "riprova". */
function renderReconnect(){
  const d = document.createElement('div');
  d.className = 'authwrap';
  d.innerHTML = `
    <div class="authbox">
      <div class="logo"><div class="mark">📋</div><h1>Presencer</h1><p>Sei ancora collegato al tuo account.</p></div>
      <div class="card">
        <p style="margin:0 0 14px">${esc(S.reconnectMsg || 'Non riesco a contattare il server.')}</p>
        <button class="btn block" id="rc_retry" ${S.busy?'disabled':''}>${S.busy?'Riprovo...':'Riprova'}</button>
        <button class="btn ghost block" id="rc_out" style="margin-top:8px">Esci dall'account</button>
      </div>
    </div>`;
  d.querySelector('#rc_retry').onclick = retryAfterReconnect;
  d.querySelector('#rc_out').onclick = doLogout;
  return d;
}

async function retryAfterReconnect(){
  if(S.busy || signInBusy) return;
  if(!S.session){ S.view='auth'; render(); return; }
  S.busy = true; render();
  await handleSignedIn();
  if(S.view==='reconnect'){ S.busy = false; render(); }
}

function renderNoWorkspace(){
  const d = document.createElement('div');
  d.className = 'authwrap';
  d.innerHTML = `
    <div class="authbox">
      <div class="logo"><div class="mark">📋</div><h1>Nessuno spazio</h1><p>Il tuo account funziona, ma non è collegato a nessuno spazio. Creane uno o entra con un codice invito.</p></div>
      <div class="card">
        <form id="nw_form">
          <label class="field"><span>Il tuo nome</span><input type="text" autocomplete="name" id="nw_name2"></label>
          <label class="field"><span>Nome dello spazio</span><input type="text" id="nw_ws2"></label>
          <button type="submit" class="btn block" id="nw_go2">Crea spazio</button>
        </form>
        <form id="nw_join" style="margin-top:18px;border-top:1px solid rgba(0,0,0,.08);padding-top:14px">
          <label class="field"><span>Oppure entra con un codice invito</span><input type="text" id="nw_code2" autocapitalize="characters" autocomplete="off" spellcheck="false" style="text-transform:uppercase"></label>
          <button type="submit" class="btn secondary block">Entra nello spazio</button>
        </form>
        <button class="btn ghost block" id="nw_out2" style="margin-top:8px">Esci</button>
      </div>
    </div>`;
  const name2 = ()=> d.querySelector('#nw_name2').value.trim();
  d.querySelector('#nw_form').onsubmit = (e)=>{
    e.preventDefault();
    createFirstWorkspaceAfterOrphan(name2(), d.querySelector('#nw_ws2').value.trim());
  };
  d.querySelector('#nw_join').onsubmit = (e)=>{
    e.preventDefault();
    joinWorkspaceAfterOrphan(name2(), d.querySelector('#nw_code2').value.trim());
  };
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
  if(S.authTab==='reset') return renderResetRequest();
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
        ${S.authErr ? `<div class="errbox" role="alert">${esc(S.authErr)}</div>` : ''}
        ${S.authMsg ? `<div class="okbox" role="status">${esc(S.authMsg)}</div>` : ''}
        <form id="authform" novalidate></form>
      </div>
    </div>`;
  d.querySelectorAll('.authtabs button').forEach(b=> b.onclick = ()=>{ S.authTab=b.dataset.t; S.authErr=''; S.authMsg=''; render(); });

  const emailAttrs = EMAIL_ATTRS;
  const form = d.querySelector('#authform');
  if(tab==='login'){
    form.innerHTML = `
      <label class="field"><span>Email</span><input ${emailAttrs} id="a_email"></label>
      <label class="field"><span>Password</span><input type="password" autocomplete="current-password" id="a_pass"></label>
      <label class="checkrow"><input type="checkbox" id="a_remember" ${rememberMe?'checked':''}><span>Ricordami su questo dispositivo</span></label>
      <button type="submit" class="btn block" id="a_go" ${S.busy?'disabled':''}>${S.busy?'Attendere...':'Accedi'}</button>
      <div class="linkline"><button type="button" id="a_forgot">Password dimenticata?</button></div>`;
  } else if(tab==='register'){
    form.innerHTML = `
      <label class="field"><span>Il tuo nome</span><input type="text" autocomplete="name" id="a_name"></label>
      <label class="field"><span>Nome dello spazio (palestra, azienda, famiglia...)</span><input type="text" id="a_ws"></label>
      <label class="field"><span>Email</span><input ${emailAttrs} id="a_email"></label>
      <label class="field"><span>Password</span><input type="password" autocomplete="new-password" id="a_pass"></label>
      <button type="submit" class="btn block" id="a_go" ${S.busy?'disabled':''}>${S.busy?'Attendere...':'Crea il mio spazio'}</button>
      <p class="hint">Almeno 6 caratteri. Diventerai amministratore e potrai invitare gli altri con un codice.</p>`;
  } else {
    form.innerHTML = `
      <label class="field"><span>Il tuo nome</span><input type="text" autocomplete="name" id="a_name"></label>
      <label class="field"><span>Codice invito</span><input type="text" id="a_code" autocapitalize="characters" autocomplete="off" spellcheck="false" style="text-transform:uppercase"></label>
      <label class="field"><span>Email</span><input ${emailAttrs} id="a_email"></label>
      <label class="field"><span>Password</span><input type="password" autocomplete="new-password" id="a_pass"></label>
      <button type="submit" class="btn block" id="a_go" ${S.busy?'disabled':''}>${S.busy?'Attendere...':'Entra nello spazio'}</button>
      <p class="hint">La password deve avere almeno 6 caratteri.</p>`;
  }

  // Un vero <form>: così l'invio da tastiera (Enter / tasto "Vai" del telefono)
  // dal campo password funziona come il tocco sul pulsante.
  const val = id => { const el = form.querySelector(id); return el ? el.value : ''; };
  const forgot = form.querySelector('#a_forgot');
  if(forgot) forgot.onclick = ()=>{
    S.authEmail = cleanEmail(val('#a_email'));
    S.authTab = 'reset'; S.authErr = ''; S.authMsg = '';
    render();
  };
  form.onsubmit = (e)=>{
    e.preventDefault();
    if(S.busy) return;
    if(tab==='login'){
      const rem = form.querySelector('#a_remember');
      rememberMe = rem ? rem.checked : rememberMe;
      localStorage.setItem('rememberMe', rememberMe?'1':'0');
      doLogin(val('#a_email'), val('#a_pass'));
    } else if(tab==='register'){
      doRegisterWorkspace(val('#a_name').trim(), val('#a_ws').trim(), val('#a_email'), val('#a_pass'));
    } else {
      doJoin(val('#a_name').trim(), val('#a_code').trim(), val('#a_email'), val('#a_pass'));
    }
  };
  const im = installMode();
  if(im) d.appendChild(renderInstallBar(im, false));
  return d;
}

/* Schermata "ho dimenticato la password": chiede solo l'email */
function renderResetRequest(){
  const d = document.createElement('div');
  d.className = 'authwrap';
  d.innerHTML = `
    <div class="authbox">
      <div class="logo"><div class="mark">🔑</div><h1>Password dimenticata</h1><p>Ti mandiamo un link per sceglierne una nuova.</p></div>
      <div class="card">
        ${S.authErr ? `<div class="errbox" role="alert">${esc(S.authErr)}</div>` : ''}
        ${S.authMsg ? `<div class="okbox" role="status">${esc(S.authMsg)}</div>` : ''}
        <form id="resetform" novalidate>
          <label class="field"><span>Email</span><input ${EMAIL_ATTRS} id="r_email" value="${esc(S.authEmail)}"></label>
          <button type="submit" class="btn block" ${S.busy?'disabled':''}>${S.busy?'Invio...':'Invia il link'}</button>
        </form>
        <p class="hint">Il link vale poco tempo e una volta sola: se scade, richiedilo di nuovo.</p>
        <div class="linkline"><button type="button" id="r_back">Torna all'accesso</button></div>
      </div>
    </div>`;
  const form = d.querySelector('#resetform');
  form.onsubmit = (e)=>{
    e.preventDefault();
    if(S.busy) return;
    doResetPassword(form.querySelector('#r_email').value);
  };
  d.querySelector('#r_back').onclick = ()=>{
    S.authTab = 'login'; S.authErr = ''; S.authMsg = ''; render();
  };
  return d;
}

/* Ultimo passo del recupero: si sceglie la nuova password */
function renderNewPassword(){
  const d = document.createElement('div');
  d.className = 'authwrap';
  d.innerHTML = `
    <div class="authbox">
      <div class="logo"><div class="mark">🔑</div><h1>Nuova password</h1><p>Scegli la password che userai da adesso.</p></div>
      <div class="card">
        ${S.authErr ? `<div class="errbox" role="alert">${esc(S.authErr)}</div>` : ''}
        <form id="newpassform" novalidate>
          <label class="field"><span>Nuova password</span><input type="password" autocomplete="new-password" id="np_pass1"></label>
          <label class="field"><span>Ripeti la password</span><input type="password" autocomplete="new-password" id="np_pass2"></label>
          <button type="submit" class="btn block" ${S.busy?'disabled':''}>${S.busy?'Attendere...':'Salva ed entra'}</button>
          <p class="hint">Almeno 6 caratteri.</p>
        </form>
        <button class="btn ghost block" id="np_cancel" style="margin-top:8px">Annulla</button>
      </div>
    </div>`;
  const form = d.querySelector('#newpassform');
  form.onsubmit = (e)=>{
    e.preventDefault();
    if(S.busy) return;
    doSetNewPassword(form.querySelector('#np_pass1').value, form.querySelector('#np_pass2').value);
  };
  d.querySelector('#np_cancel').onclick = cancelPasswordRecovery;
  return d;
}

function renderInstallBar(mode, aboveTab){
  const bar = document.createElement('div');
  bar.className = 'installbar' + (aboveTab ? ' above-tab' : '');
  bar.innerHTML = `
    <span style="font-size:22px">📲</span>
    <div class="txt">Installa Presencer<small>${(mode==='ios'||mode==='android')?'Aggiungila alla schermata Home':'Aprila come app, a schermo intero'}</small></div>
    <button class="go">${mode==='ios'?'Come fare':'Installa'}</button>
    <button class="cl" title="Non ora">✕</button>`;
  const go = bar.querySelector('.go');
  go.onclick = async ()=>{
    if(mode!=='ios'){ go.disabled = true; go.textContent = 'Attendi...'; }
    try{ await doInstall(); }
    finally{ go.disabled = false; go.textContent = mode==='ios'?'Come fare':'Installa'; }
  };
  bar.querySelector('.cl').onclick = dismissInstall;
  return bar;
}

function renderDataError(){
  const panel = document.createElement('section');
  panel.className = 'data-error';
  panel.setAttribute('role', 'alert');
  panel.innerHTML = `<b>${esc(S.dataError.action)}</b><p>${esc(S.dataError.message)}</p>
    <small>Codice: ${esc(S.dataError.code)}</small>
    <button class="btn secondary sm" ${S.syncBusy || S.presenceSaving ? 'disabled' : ''}>Aggiorna dati</button>`;
  panel.querySelector('button').onclick = refreshCurrentData;
  return panel;
}

function renderShell(){
  const wrap = document.createElement('div');
  const allView = S.tab==='presenze' && S.showAllMatrix;
  if(allView && S.matrixFullscreen) wrap.className = 'fullscreen-mode';

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
  if(allView) main.className = 'wide';
  if(S.dataError) main.appendChild(renderDataError());
  if(S.tab==='presenze') main.appendChild(renderPresenze());
  if(S.tab==='ore') main.appendChild(renderOre());
  if(S.tab==='calendari') main.appendChild(renderCalendari());
  if(S.tab==='istruttori') main.appendChild(renderIstruttori());
  if(S.tab==='profilo') main.appendChild(renderProfilo());
  wrap.appendChild(main);

  // tabbar
  const nav = document.createElement('nav');
  nav.className = 'tabbar';
  const tabs = [['presenze','✅','Presenze']];
  if(!isGuest()) tabs.push(['ore','⏱️','Ore']);
  if(!isGuest() && isAdmin()) tabs.push(['calendari','🗓️','Calendari']);
  if(!isGuest() && isAdmin()) tabs.push(['istruttori','👥','Istruttori']);
  tabs.push(['profilo','👤', isGuest()?'Esci':'Profilo']);
  nav.innerHTML = tabs.map(([id,ic,lb])=>`<button data-tab="${id}" class="${S.tab===id?'active':''}"><span class="ic">${ic}</span>${lb}</button>`).join('');
  nav.querySelectorAll('button').forEach(b=> b.onclick = ()=>{
    S.tab=b.dataset.tab;
    S.matrixFullscreen = false;
    if(S.tab==='istruttori'){ loadInstructors(); loadGuestLinks(); }
    if(S.tab==='ore') loadReport();
    render();
  });
  wrap.appendChild(nav);

  const im = installMode();
  if(im) wrap.appendChild(renderInstallBar(im, true));

  if(S.modal) wrap.appendChild(renderModal());

  return wrap;
}

/* -------- Presenze tab -------- */
function renderPresenze(){
  const d = document.createElement('div');
  const monday = mondayOf(S.weekOffset);
  const curWeekCalId = getEffectiveCalendarForWeek(monday);
  const curCal = S.calendars.find(c=>c.id===curWeekCalId);

  const calSelect = S.calendars.length ? `
    <select class="calpick" id="calpick" title="Calendario visualizzato per questa settimana" ${S.presenceSaving || S.syncBusy ? 'disabled' : ''}>
      <option value="auto" ${!S.selectedCalendarOverrideId?'selected':''}>Auto (${esc(curCal?curCal.name:'Attivo')})</option>
      ${S.calendars.map(c=>`<option value="${c.id}" ${S.selectedCalendarOverrideId===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}
    </select>` : '';

  d.innerHTML = `
    <div class="row between" style="margin-bottom:12px">
      <h1 style="margin:0">Presenze</h1>
      ${calSelect}
    </div>
    <div class="row presence-sync">
      <button class="btn secondary sm" id="refreshData" ${S.presenceSaving || S.syncBusy || S.weekLoading ? 'disabled' : ''}>Aggiorna dati</button>
      <span class="hint" role="status">${S.presenceSaving ? 'Salvataggio in corso…' : S.syncBusy || S.weekLoading ? 'Aggiornamento in corso…' : ''}</span>
    </div>
    ${S.calendars.length===0 ? `
      <div class="card empty"><div class="big">🗓️</div>
        ${isAdmin() ? 'Nessun calendario ancora. Vai su <b>Calendari</b> per crearne uno.' : 'Nessun calendario è stato ancora creato per questo spazio.'}
      </div>` : `
      <div class="weeknav">
        <button class="arrow" id="wkPrev" aria-label="Settimana precedente" ${S.presenceSaving || S.syncBusy ? 'disabled' : ''}>‹</button>
        <div class="wk${S.navDir==='next'?' wk-in-right':S.navDir==='prev'?' wk-in-left':''}">${fmtRange(monday)}<small>${S.weekOffset===0?'Questa settimana':(S.weekOffset>0?'Tra '+S.weekOffset+' settiman'+(S.weekOffset>1?'e':'a'):S.weekOffset+' settimane fa')}</small></div>
        <button class="arrow" id="wkNext" aria-label="Settimana successiva" ${S.presenceSaving || S.syncBusy ? 'disabled' : ''}>›</button>
      </div>
      <div class="row" style="margin-bottom:14px">
        <button class="btn secondary sm" id="wkToday" ${S.presenceSaving || S.syncBusy ? 'disabled' : ''}>Oggi</button>
        <button class="btn secondary sm" id="addExtraBtn" ${presenceControlsDisabled() ? 'disabled' : ''}>+ Lezione extra</button>
        <div class="segbtns" id="viewSeg">
          <button data-v="mine" class="${!S.showAllMatrix?'on':''}">Personale</button>
          <button data-v="all" class="${S.showAllMatrix?'on':''}">Tutti</button>
        </div>
        ${S.showAllMatrix ? `<button class="btn secondary sm" id="fsBtn">${S.matrixFullscreen?'✕ Esci da schermo intero':'⤢ Schermo intero'}</button>` : ''}
      </div>
      ${S.showAllMatrix ? '<p class="hint">La vista Tutti è di sola consultazione. Per modificare le tue presenze scegli Personale.</p>' : ''}
      <div id="absenceHost"></div>
      <div id="daysHost"></div>
    `}
  `;

  d.querySelector('#refreshData').onclick = refreshCurrentData;
  if(S.calendars.length===0) return d;

  if(calSelect){
    d.querySelector('#calpick').onchange = async (e)=>{
      if(e.target.value === 'auto'){
        S.selectedCalendarOverrideId = null;
      } else {
        S.selectedCalendarOverrideId = e.target.value;
      }
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
  const fsBtn = d.querySelector('#fsBtn');
  if(fsBtn) fsBtn.onclick = ()=>{ S.matrixFullscreen = !S.matrixFullscreen; render(); };
  d.querySelectorAll('#viewSeg button').forEach(b=> b.onclick = async ()=>{
    const wantAll = b.dataset.v==='all';
    if(wantAll===S.showAllMatrix) return;
    S.showAllMatrix = wantAll;
    if(!wantAll) S.matrixFullscreen = false;
    if(S.showAllMatrix && S.instructors.length===0) await loadInstructors();
    render();
  });

  const pending = S.absenceRequests.filter(r=> r.status==='in_attesa' && r.date>=todayISO());
  if(pending.length){
    const card = document.createElement('div');
    card.className = 'card absence-card';
    card.innerHTML = `<h3>Richieste di assenza (${pending.length})</h3>`;
    pending.forEach(r=>{
      const mine = r.instructor_id===myProfileId();
      const [y,m,dd] = r.date.split('-').map(Number);
      const row = document.createElement('div');
      row.className = 'listrow';
      row.innerHTML = `<div class="main"><div class="t">${esc(instructorName(r.instructor_id))} · ${esc(absenceLesson(r))}</div>
          <div class="s">${WEEKDAYS[(new Date(y,m-1,dd).getDay()+6)%7]} ${dd} ${MONTHS[m-1]}${r.reason ? ' · '+esc(r.reason) : ''}</div></div>
        ${isAdmin() ? `<button class="btn sm" data-ok ${presenceControlsDisabled()?'disabled':''}>Approva</button><button class="btn ghost sm" data-no ${presenceControlsDisabled()?'disabled':''}>Rifiuta</button>`
          : mine ? `<button class="btn ghost sm" data-wd ${presenceControlsDisabled()?'disabled':''}>Ritira</button>` : '<span class="pill">In attesa</span>'}`;
      const ok = row.querySelector('[data-ok]'); if(ok) ok.onclick = ()=> decideAbsence(r.id, 'approvata');
      const no = row.querySelector('[data-no]'); if(no) no.onclick = ()=> decideAbsence(r.id, 'rifiutata');
      const wd = row.querySelector('[data-wd]'); if(wd) wd.onclick = ()=>{ if(confirm('Ritirare la richiesta di assenza?')) withdrawAbsence(r.id); };
      card.appendChild(row);
    });
    d.querySelector('#absenceHost').appendChild(card);
  }

  const host = d.querySelector('#daysHost');
  // I giorni restano a schermo mentre la stessa settimana si aggiorna: svuotarli
  // farebbe lampeggiare il calendario a ogni salvataggio o sincronizzazione.
  const weekDataUsable = S.weekDataContext === presenceContext();
  if(S.weekLoadFailed || (S.weekLoading && !weekDataUsable)){
    host.innerHTML = `<p class="hint" role="status">${S.weekLoading ? 'Caricamento presenze…' : 'Presenze non disponibili. Premi “Aggiorna dati” per riprovare.'}</p>`;
    return d;
  }
  const dates = weekDates(monday);
  dates.forEach(dt=>{
    host.appendChild(S.showAllMatrix ? renderDayMatrix(dt) : renderDayList(dt));
  });
  if(S.navDir==='next') host.classList.add('wk-in-right');
  else if(S.navDir==='prev') host.classList.add('wk-in-left');
  S.navDir = null;
  attachSwipeWeekNav(host);
  if(S.showAllMatrix) syncMatrixScroll(host);
  return d;
}

function attachSwipeWeekNav(el){
  let sx=null, sy=null, scroller=null, startScroll=0, maxScroll=0;
  el.addEventListener('touchstart', e=>{
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    // se il tocco parte su una matrice scrollabile, ricordane lo scroll:
    // lo swipe cambierà settimana solo quando la tabella è già al bordo.
    scroller = e.target.closest('.matrixwrap');
    if(scroller){
      startScroll = scroller.scrollLeft;
      maxScroll = scroller.scrollWidth - scroller.clientWidth;
    } else { maxScroll = 0; }
  }, {passive:true});
  el.addEventListener('touchend', e=>{
    if(S.presenceSaving || S.syncBusy) return;
    if(sx===null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if(!(Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)*1.5)) return;
    const forward = dx < 0;
    // se sto scorrendo dentro una tabella che può ancora scrollare in quella
    // direzione, lascio scorrere la tabella e non cambio settimana.
    if(scroller && maxScroll > 2){
      if(forward && startScroll < maxScroll - 2) return;
      if(!forward && startScroll > 2) return;
    }
    S.weekOffset += forward ? 1 : -1;
    S.navDir = forward ? 'next' : 'prev';
    refreshWeekData();
  }, {passive:true});
}

/* Ogni giorno ha la sua tabella scorrevole. Se scorrono separatamente, appena
   sposti un giorno le colonne non sono piu' allineate con gli altri e la visione
   d'insieme si perde: qui le muoviamo tutte insieme. */
function syncMatrixScroll(host){
  const wraps = Array.from(host.querySelectorAll('.matrixwrap'));
  if(wraps.length < 2) return;
  let syncing = false;
  wraps.forEach(w=> w.addEventListener('scroll', ()=>{
    if(syncing) return;
    syncing = true;
    const x = w.scrollLeft;
    wraps.forEach(other=>{ if(other!==w && other.scrollLeft!==x) other.scrollLeft = x; });
    requestAnimationFrame(()=>{ syncing = false; });
  }, {passive:true}));
}

function slotsForDate(dt){
  const wd = (dt.getDay()+6)%7;
  const dateStr = toISO(dt);
  const effectiveCalId = S.selectedCalendarOverrideId || calendarForDate(dateStr);
  const weekly = S.slots
    .filter(s=> s.calendar_id === effectiveCalId && s.weekday===wd)
    .map(s=>({ref:{slot_id:s.id}, label:s.label, start:s.start_time, end:s.end_time, extra:false, id:s.id, calendar_id:s.calendar_id, cancelled:cancellationFor(s.id, dateStr)}));
  const extras = S.extraSlots
    .filter(e=> e.date===dateStr && (!e.calendar_id || e.calendar_id === effectiveCalId))
    .map(e=>({ref:{extra_slot_id:e.id}, label:e.label, start:e.start_time, end:e.end_time, extra:true, id:e.id, calendar_id:e.calendar_id, created_by:e.created_by}));
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
    if(it.cancelled){
      const row = document.createElement('div');
      row.className = 'slot cancelled';
      row.innerHTML = `
        <div class="time">${fmtHM(it.start)}<br>${fmtHM(it.end)}</div>
        <div class="info"><div class="lbl">${esc(it.label)}</div><div class="sub">Annullata${it.cancelled.reason ? ' · '+esc(it.cancelled.reason) : ''}</div></div>
        ${isAdmin() ? `<button class="btn ghost sm" data-restore ${presenceControlsDisabled() ? 'disabled' : ''}>Ripristina</button>` : ''}`;
      const restore = row.querySelector('[data-restore]');
      if(restore) restore.onclick = ()=>{ if(confirm('Ripristinare questa lezione?')) restoreLesson(it.cancelled.id); };
      day.appendChild(row);
      return;
    }
    const state = myAttendanceState(it.ref, dateStr);
    const btnClass = state==='presente' ? 'on' : state==='assente' ? 'off' : state==='ricorrente' ? 'on rec' : state==='ricorrente-assente' ? 'off rec' : '';
    const btnLabel = state==='presente' ? '✅ Presente' : state==='assente' ? '❌ Assente' : state==='ricorrente' ? '✅ Presente 🔁' : state==='ricorrente-assente' ? '❌ Assente 🔁' : 'Segna presenza';
    const canRecur = !it.extra && !isGuest();
    const recurOn = canRecur && isMyRecurring(it.id);
    const canLog = !isGuest();
    const logCount = canLog ? logsFor(it.ref, dateStr).length : 0;
    const iHaveLog = canLog && !!myLessonLog(it.ref, dateStr);
    const absence = myAbsenceRequest(it.ref, dateStr);
    const absenceText = !absence ? '' : absence.status==='in_attesa' ? ' · ⏳ assenza richiesta' : absence.status==='approvata' ? ' · assenza approvata' : ' · assenza rifiutata';
    const row = document.createElement('div');
    row.className = 'slot' + (it.extra ? ' extra' : '');
    row.innerHTML = `
      <div class="time">${fmtHM(it.start)}<br>${fmtHM(it.end)}</div>
      <div class="info"><div class="lbl">${esc(it.label)}</div><div class="sub">${it.extra?'Lezione extra':'Ricorrente'}${absenceText}</div></div>
      ${!isGuest() ? `<button class="btn ghost sm morebtn" title="Altre azioni: richiesta di assenza${isAdmin()?', annulla lezione':''}" aria-label="Altre azioni">⋯</button>` : ''}
      ${canLog ? `<button class="btn ghost sm logbtn ${iHaveLog?'on':''}" title="Registro lezione: cosa hai fatto">📝${logCount?`<span class="logbadge">${logCount}</span>`:''}</button>` : ''}
      ${canRecur ? `<button class="btn ghost sm recurbtn ${recurOn?'on':''}" title="Ripeti lo stato ogni settimana su questo orario" ${presenceControlsDisabled() ? 'disabled' : ''}>🔁</button>` : ''}
      <button class="togglebtn ${btnClass}" ${presenceControlsDisabled() ? 'disabled' : ''}>${btnLabel}</button>
      ${it.extra && (isAdmin() || (S.profile && it.created_by===myProfileId())) ? `<button class="btn ghost sm" data-del="${it.id}" aria-label="Elimina lezione extra" ${presenceControlsDisabled() ? 'disabled' : ''}>✕</button>` : ''}
    `;
    row.querySelector('.togglebtn').onclick = ()=> cycleAttendance(it.ref, dateStr);
    const logBtn = row.querySelector('.logbtn');
    if(logBtn) logBtn.onclick = async ()=>{
      if(S.instructors.length===0) await loadInstructors(); // per mostrare i nomi degli autori
      openModal({type:'lesson-log', ref:it.ref, date:dateStr, label:it.label, start:it.start, end:it.end});
    };
    const recurBtn = row.querySelector('.recurbtn');
    if(recurBtn) recurBtn.onclick = ()=> toggleRecurring(it.ref, it.id, dateStr);
    const moreBtn = row.querySelector('.morebtn');
    if(moreBtn) moreBtn.onclick = ()=> openModal({type:'lesson-actions', ref:it.ref, date:dateStr, label:it.label, start:it.start, end:it.end, extra:it.extra, slotId:it.id});
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
  const isToday = dateStr===todayISO();
  day.innerHTML = `<h3 class="dayhead">${WEEKDAYS[(dt.getDay()+6)%7]} <span class="d">${fmtDayShort(dt)}${isToday?' · oggi':''}</span></h3>`;
  const items = slotsForDate(dt).filter(it=> !it.cancelled);
  if(items.length===0){ day.innerHTML += `<p class="hint" style="margin-bottom:12px">Nessuna lezione.</p>`; return day; }

  const people = (S.instructors.length ? S.instructors : [S.profile].filter(Boolean))
    .map(p=>({key:'p_'+p.id, name:p.name, avatar:p.avatar_url, guestCol:false, instructorId:p.id, match:a=>a.instructor_id===p.id}));
  const guestMap = new Map();
  S.attendance.forEach(a=>{ if(a.guest_token && !guestMap.has(a.guest_token)) guestMap.set(a.guest_token, a.guest_name||'Ospite'); });
  const guests = Array.from(guestMap, ([token,name])=>({key:'g_'+token, name, guestCol:true, match:a=>a.guest_token===token}));
  const cols = people.concat(guests);

  const wrapT = document.createElement('div'); wrapT.className='matrixwrap card';
  wrapT.setAttribute('data-keep-scroll', 'matrix-'+dateStr);
  const colHead = c=>{
    const first = c.name.split(' ')[0] || '?';
    const avatarInner = c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : esc(first.slice(0,1).toUpperCase());
    return `<th><div class="mhead-person"><span class="mavatar${c.guestCol?' guest':''}" style="background:${colorFor(c.key)}">${avatarInner}</span><span class="mname">${esc(first)}</span></div></th>`;
  };
  const canLog = !isGuest();
  let html = `<table class="matrix"><thead><tr><th>Orario</th>${cols.map(colHead).join('')}</tr></thead><tbody>`;
  items.forEach((it,idx)=>{
    const logCount = canLog ? logsFor(it.ref, dateStr).length : 0;
    const iHaveLog = canLog && !!myLessonLog(it.ref, dateStr);
    const logBtn = canLog ? `<button class="mlogbtn ${iHaveLog?'on':''}" data-li="${idx}" title="Registro lezione">📝${logCount?`<span class="logbadge">${logCount}</span>`:''}</button>` : '';
    html += `<tr><td><div class="mlesson"><span class="mtop"><span class="mtime">${fmtHM(it.start)}</span>${logBtn}</span><span class="mlabel" title="${esc(it.label)}">${esc(it.label)}</span></div></td>`;
    cols.forEach(c=>{
      const row = S.attendance.find(a=>{
        const sameSlot = it.ref.slot_id ? a.slot_id===it.ref.slot_id : a.extra_slot_id===it.ref.extra_slot_id;
        return sameSlot && a.date===dateStr && c.match(a);
      });
      let state = row ? row.status : null;
      if(!state && !c.guestCol && !it.extra){
        const rs = recurringStatusOn(it.id, c.instructorId, dateStr);
        if(rs) state = rs==='assente' ? 'ricorrente-assente' : 'ricorrente';
      }
      const cls = state==='presente' ? 'on' : state==='ricorrente' ? 'on rec' : state==='ricorrente-assente' ? 'off rec' : state==='assente' ? 'off' : '';
      html += `<td><span class="mchip ${cls}"></span></td>`;
    });
    html += `</tr>`;
  });
  html += `</tbody></table>`;
  wrapT.innerHTML = html;
  if(canLog){
    wrapT.querySelectorAll('.mlogbtn').forEach(b=> b.onclick = async ()=>{
      const it = items[+b.dataset.li];
      if(!it) return;
      if(S.instructors.length===0) await loadInstructors();
      openModal({type:'lesson-log', ref:it.ref, date:dateStr, label:it.label, start:it.start, end:it.end});
    });
  }
  if(cols.length>3){
    const hint = document.createElement('div');
    hint.className = 'matrixhint';
    hint.textContent = '← scorri per vedere tutti →';
    day.appendChild(hint);
  }
  day.appendChild(wrapT);
  return day;
}

/* -------- Ore tab: ore e compensi (ognuno vede i propri, l'admin tutti) -------- */
function renderOre(){
  const d = document.createElement('div');
  const {from, to} = reportRange();
  const data = S.reportData && S.reportData.from===from && S.reportData.to===to ? S.reportData : null;
  const today = todayISO();
  const fmtDate = iso=>{ const [y,m,dd] = iso.split('-').map(Number); return `${dd} ${MONTHS[m-1]} ${y}`; };
  const periodLabel = S.reportMode==='month'
    ? new Date(+from.slice(0,4), +from.slice(5,7)-1, 1).toLocaleDateString('it-IT', {month:'long', year:'numeric'})
    : `${fmtDate(from)} – ${fmtDate(to)}`;
  d.innerHTML = `
    <div class="row between noprint" style="margin-bottom:12px">
      <h1 style="margin:0">Ore e compensi</h1>
      ${isAdmin() ? '<button class="btn secondary sm" id="payRules">⚙️ Regole e tariffe</button>' : ''}
    </div>
    <div class="row noprint" style="margin-bottom:12px">
      <div class="segbtns" id="repMode">
        <button data-m="week" class="${S.reportMode==='week'?'on':''}">Settimana</button>
        <button data-m="month" class="${S.reportMode==='month'?'on':''}">Mese</button>
        <button data-m="custom" class="${S.reportMode==='custom'?'on':''}">Periodo</button>
      </div>
      ${isAdmin() ? `<select id="repPerson" class="calpick"><option value="">Tutti</option>${S.instructors.map(p=>`<option value="${p.id}" ${S.reportPerson===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
    </div>
    ${S.reportMode==='custom' ? `
      <div class="row noprint" style="margin-bottom:12px">
        <label class="field grow" style="margin:0"><span>Dal</span><input type="date" id="repFrom" value="${from}"></label>
        <label class="field grow" style="margin:0"><span>Al</span><input type="date" id="repTo" value="${to}"></label>
        <button class="btn secondary sm" id="repGo" style="align-self:flex-end">Calcola</button>
      </div>` : `
      <div class="weeknav noprint">
        <button class="arrow" id="repPrev" aria-label="Periodo precedente">‹</button>
        <div class="wk">${esc(periodLabel)}<small>${to>today ? 'Contate le lezioni fino a oggi' : 'Periodo concluso'}</small></div>
        <button class="arrow" id="repNext" aria-label="Periodo successivo">›</button>
      </div>`}
    <div class="printonly"><h2>${esc(S.workspace.name)} · Ore e compensi</h2><p>${esc(periodLabel)}${to>today ? ' (fino al '+esc(fmtDate(today))+')' : ''}</p></div>
    <div id="repHost"></div>`;

  d.querySelectorAll('#repMode button').forEach(b=> b.onclick = ()=>{
    if(b.dataset.m==='custom'){ S.reportFrom = from; S.reportTo = to; }
    else S.reportFrom = '';
    S.reportMode = b.dataset.m; loadReport();
  });
  const rules = d.querySelector('#payRules');
  if(rules) rules.onclick = ()=> openModal({type:'pay-settings'});
  const personSel = d.querySelector('#repPerson');
  if(personSel) personSel.onchange = ()=>{ S.reportPerson = personSel.value; render(); };
  const prev = d.querySelector('#repPrev'); if(prev) prev.onclick = ()=> shiftReport(-1);
  const next = d.querySelector('#repNext'); if(next) next.onclick = ()=> shiftReport(1);
  const go = d.querySelector('#repGo');
  if(go) go.onclick = ()=>{
    const f = d.querySelector('#repFrom').value, t = d.querySelector('#repTo').value;
    if(!f || !t || t<f) return toast('Scegli un periodo valido.');
    S.reportFrom = f; S.reportTo = t; loadReport();
  };

  const host = d.querySelector('#repHost');
  if(!data){
    host.innerHTML = `<p class="hint" role="status">${S.reportLoading ? 'Calcolo in corso…' : 'Dati non caricati.'}</p>`;
    if(!S.reportLoading){
      const retry = document.createElement('button');
      retry.className = 'btn secondary sm'; retry.textContent = 'Calcola';
      retry.onclick = loadReport; host.appendChild(retry);
    }
    return d;
  }
  // le lezioni future non sono ancora state fatte
  const upTo = to < today ? to : today;
  const all = from>upTo ? [] : computePayroll(Object.assign({}, data, {to:upTo}), S.paySettings, S.instructors, calendarForDate);
  // l'istruttore vede solo i propri numeri
  const rows = all.filter(p=> isAdmin() ? (!S.reportPerson || p.key===S.reportPerson) && (p.lessons || p.key===S.reportPerson || S.instructors.some(i=>i.id===p.key)) : p.key===myProfileId());
  const tot = rows.reduce((a,p)=>({hours:a.hours+p.hours, amount:a.amount+p.amount, lessons:a.lessons+p.lessons}), {hours:0, amount:0, lessons:0});

  const summary = document.createElement('div');
  summary.className = 'card';
  summary.innerHTML = `
    <table class="report">
      <thead><tr><th>Persona</th><th>Lezioni</th><th>Ore</th><th>Compenso</th></tr></thead>
      <tbody>${rows.map(p=>`<tr><td>${esc(p.name)}${p.grade==='maestro'?' <span class="tag">Maestro</span>':''}</td><td>${p.lessons}</td><td>${fmtHours(p.hours)}</td><td>${euro(p.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">Nessuna lezione nel periodo.</td></tr>'}</tbody>
      ${rows.length>1 ? `<tfoot><tr><td>Totale</td><td>${tot.lessons}</td><td>${fmtHours(tot.hours)}</td><td>${euro(tot.amount)}</td></tr></tfoot>` : ''}
    </table>
    <div class="row noprint" style="margin-top:12px">
      <label class="checkrow" style="margin:0"><input type="checkbox" id="repDetail" ${S.reportDetail?'checked':''}><span>Dettaglio lezioni</span></label>
      <span class="grow"></span>
      <button class="btn secondary sm" id="repCsv">⬇ CSV</button>
      <button class="btn sm" id="repPrint">🖨 Stampa</button>
    </div>
    ${S.paySettings && !S.paySettings.default_rate && !Object.keys(S.paySettings.rates||{}).length ? `<p class="hint noprint">Nessuna tariffa impostata: i compensi risultano 0. ${isAdmin()?'Impostale da “Regole e tariffe”.':'Chiedi all’amministratore di impostarle.'}</p>` : ''}`;
  summary.querySelector('#repDetail').onchange = e=>{ S.reportDetail = e.target.checked; render(); };
  summary.querySelector('#repPrint').onclick = async ()=>{
    // nell'APK window.print() non fa nulla: usiamo la stampa di Android (anche "Salva come PDF")
    const native = nativeNotifications();
    if(!native) return window.print();
    if(!native.printPage) return toast('Aggiorna l’app per stampare o salvare in PDF.');
    try{ await native.printPage(`Ore ${from} - ${upTo}`); }
    catch(e){ console.error('Presencer: stampa', e); toast('Stampa non disponibile su questo dispositivo.'); }
  };
  summary.querySelector('#repCsv').onclick = ()=>{
    const name = `ore-${from}-${upTo}.csv`;
    if(!downloadText(name, reportCsv(rows, from, upTo), 'text/csv;charset=utf-8')) toast('Download non riuscito.');
  };
  host.appendChild(summary);

  if(S.reportDetail) rows.filter(p=>p.entries.length).forEach(p=>{
    const card = document.createElement('div');
    card.className = 'card report-detail';
    card.innerHTML = `<h3>${esc(p.name)}</h3>
      <table class="report"><thead><tr><th>Data</th><th>Lezione</th><th>Ore</th><th>Compenso</th></tr></thead><tbody>
      ${p.entries.map(e=>{ const [y,m,dd] = e.date.split('-').map(Number); return `<tr><td>${WEEKDAYS[(new Date(y,m-1,dd).getDay()+6)%7]} ${dd} ${MONTHS[m-1]}</td><td>${esc(e.label)} <span class="hint">${fmtHM(e.start)}–${fmtHM(e.end)}${e.note?' · '+esc(e.note):''}</span></td><td>${fmtHours(e.hours)}</td><td>${euro(e.amount)}</td></tr>`; }).join('')}
      </tbody><tfoot><tr><td colspan="2">Totale</td><td>${fmtHours(p.hours)}</td><td>${euro(p.amount)}</td></tr></tfoot></table>`;
    host.appendChild(card);
  });
  return d;
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

  const today = todayISO();
  const futurePeriod = (S.calendarPeriods||[]).find(p=> p.start_date > today);
  const schedCalId = futurePeriod ? futurePeriod.calendar_id : (S.workspace.scheduled_calendar_date > today ? S.workspace.scheduled_calendar_id : null);
  const schedDate = futurePeriod ? futurePeriod.start_date : (S.workspace.scheduled_calendar_date > today ? S.workspace.scheduled_calendar_date : null);

  if(schedCalId && schedDate){
    const target = S.calendars.find(c=>c.id===schedCalId);
    const banner = document.createElement('div');
    banner.className = 'card';
    banner.style.background = '#FFF1E4';
    banner.innerHTML = `
      <div class="row between">
        <div><b>🗓️ Cambio programmato</b><div class="hint" style="margin-top:2px">Il calendario passerà automaticamente a <b>${esc(target?target.name:'')}</b> a partire dal ${new Date(schedDate).toLocaleDateString('it-IT')}.</div></div>
        <button class="btn ghost sm" id="cancelSched">Annulla</button>
      </div>`;
    banner.querySelector('#cancelSched').onclick = ()=>{ if(confirm('Annullare il cambio calendario programmato?')) cancelScheduledCalendarChange(); };
    d.appendChild(banner);
  }

  const activeTodayCalId = calendarForDate(today);

  S.calendars.forEach(c=>{
    const card = document.createElement('div');
    card.className = 'card';
    const isActiveToday = activeTodayCalId === c.id;
    card.innerHTML = `
      <div class="row between">
        <div><b>${esc(c.name)}</b> <span class="tag ${c.period}">${PERIOD_LABEL[c.period]||c.period}</span> ${isActiveToday?'<span class="pill ok">Attivo oggi</span>':''}</div>
      </div>
      <div class="row wrap" style="margin-top:10px;gap:6px">
        ${!isActiveToday?`<button class="btn secondary sm" data-act="mkactive">Rendi attivo oggi</button>`:''}
        <button class="btn secondary sm" data-act="sched">Programma cambio</button>
        <button class="btn secondary sm" data-act="dup">Duplica</button>
        <button class="btn secondary sm" data-act="edit">Modifica orari</button>
        <button class="btn ghost sm" data-act="del">Elimina</button>
      </div>`;
    card.querySelector('[data-act="edit"]').onclick = ()=> openCalendarEditor(c);
    card.querySelector('[data-act="dup"]').onclick = ()=> openModal({type:'duplicate-calendar', calendarId:c.id});
    card.querySelector('[data-act="sched"]').onclick = ()=> openModal({type:'schedule-calendar', calendarId:c.id});
    if(!isActiveToday){
      card.querySelector('[data-act="mkactive"]').onclick = ()=> setActiveCalendar(c.id);
    }
    card.querySelector('[data-act="del"]').onclick = ()=>{ if(confirm(`Eliminare "${c.name}" e tutti i suoi orari?`)) deleteCalendar(c.id); };
    d.appendChild(card);
  });
  return d;
}

async function openCalendarEditor(cal){
  S.modal = {type:'edit-calendar', calendar:cal, editSlots:[], loadingSlots:true};
  lockScroll();
  render();                       // apri subito il modale, senza aspettare la rete
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
      <div class="main"><div class="t">${esc(p.name)}</div><div class="s">${p.role==='admin'?'Amministratore':'Istruttore'}${p.grade==='maestro'?' · Maestro caposcuola':''}</div></div>
      <button class="btn ghost sm" data-grade>${p.grade==='maestro'?'Togli maestro':'Rendi maestro'}</button>
      ${p.id!==S.profile.id ? `<button class="btn ghost sm" data-role>${p.role==='admin'?'Rendi istruttore':'Rendi admin'}</button>` : ''}
      ${(p.id!==S.profile.id && p.role!=='admin') ? `<button class="btn ghost sm" data-rm>Rimuovi</button>` : ''}`;
    const roleBtn = row.querySelector('[data-role]');
    if(roleBtn) roleBtn.onclick = ()=>{
      const next = p.role==='admin' ? 'instructor' : 'admin';
      const msg = next==='admin' ? `Rendere ${p.name} amministratore? Potrà modificare calendari, orari e membri.` : `Togliere i permessi di amministratore a ${p.name}?`;
      if(confirm(msg)) setInstructorRole(p.id, next);
    };
    row.querySelector('[data-grade]').onclick = ()=>{
      const next = p.grade==='maestro' ? 'istruttore' : 'maestro';
      if(confirm(next==='maestro' ? `Rendere ${p.name} maestro caposcuola? Con la regola attiva incassa per intero le lezioni a cui partecipa.` : `Togliere a ${p.name} il grado di maestro caposcuola?`)) setInstructorGrade(p.id, next);
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

  const backupCard = document.createElement('div');
  backupCard.className = 'card';
  backupCard.innerHTML = `
    <h3>Backup</h3>
    <p class="hint">Salva su file calendari, orari, lezioni extra, presenze, ricorrenze, registri e accessi rapidi di questo spazio. Utile prima di una modifica grossa.</p>
    <div class="row">
      <button class="btn secondary sm" id="bkExport" ${S.backupBusy?'disabled':''}>${S.backupBusy?'Attendi…':'⬇ Esporta backup'}</button>
      <button class="btn secondary sm" id="bkImport" ${S.backupBusy?'disabled':''}>⬆ Importa backup</button>
    </div>
    <p class="hint">Le persone e i loro account non si possono salvare in un file: restano quelle di adesso. Al ripristino le presenze vengono riagganciate ai membri con lo stesso nome; quelle di chi non c\u2019e\u2019 piu\u2019 vengono saltate e te lo diciamo.</p>`;
  backupCard.querySelector('#bkExport').onclick = exportBackup;
  backupCard.querySelector('#bkImport').onclick = pickBackupFile;
  d.appendChild(backupCard);

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
      <h3>Notifiche</h3>
      <p class="hint" style="margin:0 0 12px">Scegli quali modifiche ricevere. Le modifiche fatte da te non generano una notifica sul tuo dispositivo.</p>
      <label class="checkrow notification-master">
        <input type="checkbox" data-notification-pref="enabled" ${S.notificationPreferences.enabled?'checked':''}>
        <span><b>Attiva notifiche</b><small>${esc(notificationPermissionText())}</small></span>
      </label>
      <div class="notification-types ${S.notificationPreferences.enabled?'':'muted'}">
        ${NOTIFICATION_TYPES.map(t=>`
          <label class="checkrow">
            <input type="checkbox" data-notification-pref="${t.id}" ${S.notificationPreferences[t.id]?'checked':''} ${S.notificationPreferences.enabled?'':'disabled'}>
            <span><b>${esc(t.label)}</b><small>${esc(t.description)}</small></span>
          </label>`).join('')}
      </div>
      ${S.notificationPermission!=='granted' ? '<button class="btn secondary block" id="p_notif_permission">Consenti notifiche</button>' : ''}
      ${S.notificationSetupMissing ? '<p class="hint notification-warning">⚠️ Esegui <b>migration_notifications.sql</b> su Supabase per ricevere le modifiche degli altri utenti.</p>' : ''}
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
  d.querySelectorAll('[data-notification-pref]').forEach(input=>{
    input.onchange = ()=> setNotificationPreference(input.dataset.notificationPref, input.checked);
  });
  const notifPermission = d.querySelector('#p_notif_permission');
  if(notifPermission) notifPermission.onclick = enableDeviceNotifications;
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
  box.setAttribute('data-keep-scroll', 'modal');
  if(animatedModal !== S.modal){ box.classList.add('enter'); animatedModal = S.modal; }
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

  else if(m.type==='ios-install'){
    box.innerHTML = `
      <div class="mhead"><h2>Installa su iPhone/iPad</h2><button id="x">✕</button></div>
      <p class="hint" style="margin:0 0 12px">Per aggiungere Presencer alla schermata Home:</p>
      <ol style="margin:0 0 8px 18px;padding:0;line-height:1.8">
        <li>Tocca il pulsante <b>Condividi</b> ⬆️ nella barra di Safari.</li>
        <li>Scorri e tocca <b>Aggiungi a schermata Home</b>.</li>
        <li>Conferma con <b>Aggiungi</b> in alto a destra.</li>
      </ol>
      <button class="btn block" id="ios_ok" style="margin-top:8px">Ho capito</button>`;
    box.querySelector('#ios_ok').onclick = closeModal;
  }

  else if(m.type==='install-prompt'){
    const ios = m.mode==='ios';
    const androidManual = m.mode==='android';
    box.innerHTML = `
      <div class="mhead"><h2>Installa l'app</h2><button id="x">✕</button></div>
      <div style="text-align:center;margin:2px 0 14px">
        <div style="font-size:46px;line-height:1">📲</div>
        <p class="hint" style="margin:8px 4px 0">Aggiungi Presencer al telefono: si apre a schermo intero, parte più veloce e la usi come un'app vera.</p>
      </div>
      ${ios ? `
        <ol style="margin:0 0 14px 18px;padding:0;line-height:1.8">
          <li>Tocca <b>Condividi</b> ⬆️ nella barra di Safari.</li>
          <li>Scegli <b>Aggiungi a schermata Home</b>.</li>
          <li>Conferma con <b>Aggiungi</b>.</li>
        </ol>
        <button class="btn block" id="ip_ok">Ho capito</button>
      ` : androidManual ? `
        <ol style="margin:0 0 14px 18px;padding:0;line-height:1.8">
          <li>Tocca il menu <b>⋮</b> in alto a destra in Chrome.</li>
          <li>Scegli <b>Installa app</b> (o <b>Aggiungi a schermata Home</b>).</li>
          <li>Conferma con <b>Installa</b>.</li>
        </ol>
        <button class="btn block" id="ip_ok">Ho capito</button>
      ` : `
        <button class="btn block" id="ip_go">Installa app</button>
        <button class="btn ghost block" id="ip_later" style="margin-top:8px">Più tardi</button>
      `}`;
    const ok = box.querySelector('#ip_ok'); if(ok) ok.onclick = closeModal;
    const go = box.querySelector('#ip_go'); if(go) go.onclick = ()=>{ closeModal(); doInstall(); };
    const later = box.querySelector('#ip_later'); if(later) later.onclick = closeModal;
  }

  else if(m.type==='android-install'){
    box.innerHTML = `
      <div class="mhead"><h2>Installa su Android</h2><button id="x">✕</button></div>
      <p class="hint" style="margin:0 0 12px">Per aggiungere Presencer alla schermata Home:</p>
      <ol style="margin:0 0 8px 18px;padding:0;line-height:1.8">
        <li>Tocca il menu <b>⋮</b> in alto a destra in Chrome.</li>
        <li>Scegli <b>Installa app</b> (o <b>Aggiungi a schermata Home</b>).</li>
        <li>Conferma con <b>Installa</b>.</li>
      </ol>
      <button class="btn block" id="and_ok" style="margin-top:8px">Ho capito</button>`;
    box.querySelector('#and_ok').onclick = closeModal;
  }

  else if(m.type==='schedule-calendar'){
    const target = S.calendars.find(c=>c.id===m.calendarId);
    const defDate = nextMondayISO();
    box.innerHTML = `
      <div class="mhead"><h2>Programma cambio calendario</h2><button id="x">✕</button></div>
      <p class="hint" style="margin:0 0 12px">Passa automaticamente a <b>${esc(target?target.name:'questo calendario')}</b> a partire dalla data scelta. Tutte le settimane precedenti manterranno gli orari e le presenze del calendario precedente.</p>
      <label class="field"><span>Data di inizio validità</span><input type="date" id="s_date" value="${defDate}" min="${todayISO()}"></label>
      <button class="btn block" id="s_save">Programma cambio</button>`;
    box.querySelector('#s_save').onclick = ()=> scheduleCalendarChange(m.calendarId, box.querySelector('#s_date').value);
  }

  else if(m.type==='duplicate-calendar'){
    const src = S.calendars.find(c=>c.id===m.calendarId);
    const defName = src ? `${src.name} (nuovo)` : 'Nuovo calendario';
    box.innerHTML = `
      <div class="mhead"><h2>Duplica calendario</h2><button id="x">✕</button></div>
      <p class="hint" style="margin:0 0 12px">Crea una copia di <b>${esc(src?src.name:'')}</b> con tutti i suoi orari settimanali. Potrai poi modificare solo gli orari che cambiano e programmare la data di inizio validità.</p>
      <label class="field"><span>Nome nuovo calendario</span><input type="text" id="dc_name" value="${esc(defName)}"></label>
      <label class="field"><span>Periodo</span>
        <select id="dc_period">
          <option value="inverno" ${src&&src.period==='inverno'?'selected':''}>Inverno</option>
          <option value="estate" ${src&&src.period==='estate'?'selected':''}>Estate</option>
          <option value="extra" ${src&&src.period==='extra'?'selected':''}>Extra</option>
          <option value="personalizzato" ${src&&src.period==='personalizzato'?'selected':''}>Personalizzato</option>
        </select>
      </label>
      <button class="btn block" id="dc_save">Duplica e modifica orari</button>`;
    box.querySelector('#dc_save').onclick = ()=> duplicateCalendar(m.calendarId, box.querySelector('#dc_name').value, box.querySelector('#dc_period').value);
  }

  else if(m.type==='edit-calendar'){
    const cal = m.calendar;
    const isCurrentlyActive = calendarForDate(todayISO()) === cal.id;
    box.innerHTML = `
      <div class="mhead"><h2>${esc(cal.name)}</h2><button id="x">✕</button></div>
      ${isCurrentlyActive ? `<div class="hint" style="background:#FFF9E6;padding:8px 12px;border-radius:8px;margin-bottom:12px;font-size:13px;line-height:1.4">💡 <b>Nota:</b> Questo calendario è attualmente attivo. Se modifichi gli orari, il cambiamento si rifletterà sulle settimane in cui è valido. Se invece stai preparando il nuovo orario per la prossima stagione, ti consigliamo di usare <b>Duplica</b> dalla scheda Calendari e programmarne l'attivazione.</div>` : ''}
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
    if(m.loadingSlots) list.innerHTML = `<p class="hint">Caricamento orari…</p>`;
    else if(!(m.editSlots||[]).length) list.innerHTML = `<p class="hint">Nessun orario ancora.</p>`;
    box.querySelector('#ns_add').onclick = ()=> addSlot(cal.id, {
      weekday: box.querySelector('#ns_day').value,
      start_time: box.querySelector('#ns_start').value,
      end_time: box.querySelector('#ns_end').value,
      label: box.querySelector('#ns_label').value,
    });
  }

  else if(m.type==='backup-done'){
    box.innerHTML = `
      <div class="mhead"><h2>Backup pronto ✅</h2><button id="x">✕</button></div>
      <p class="hint">File: <b>${esc(m.name)}</b></p>
      ${backupCountsHtml(m.counts)}
      <p class="hint">Se il download non e\u2019 partito da solo (succede dentro l\u2019app Android), copia il testo qui sotto e incollalo in un file con estensione .json.</p>
      <button class="btn block" id="bk_copy">Copia negli appunti</button>`;
    box.querySelector('#bk_copy').onclick = async ()=>{
      try{ await navigator.clipboard.writeText(m.text); toast('Backup copiato negli appunti.'); }
      catch(e){ toast('Copia non riuscita.'); }
    };
  }

  else if(m.type==='backup-restore'){
    const quando = m.backup.exportedAt ? new Date(m.backup.exportedAt).toLocaleString('it-IT') : 'data sconosciuta';
    const daSpazio = m.backup.workspace && m.backup.workspace.name ? ' · spazio “'+esc(m.backup.workspace.name)+'”' : '';
    box.innerHTML = `
      <div class="mhead"><h2>Importa backup</h2><button id="x">✕</button></div>
      <p class="hint">Del ${quando}${daSpazio}</p>
      ${backupCountsHtml(m.counts)}
      <p class="hint" style="background:#FFF1E4;padding:10px;border-radius:8px;line-height:1.4">⚠️ Calendari, orari, lezioni extra, presenze, ricorrenze e registri di <b>${esc(S.workspace.name)}</b> vengono <b>cancellati</b> e sostituiti con quelli del file. Non si puo\u2019 annullare: se hai dubbi, esporta prima un backup di adesso.</p>
      <label class="field"><span>Scrivi il nome dello spazio per confermare</span><input type="text" id="bk_confirm" placeholder="${esc(S.workspace.name)}"></label>
      <button class="btn danger block" id="bk_go" ${S.backupBusy?'disabled':''}>${S.backupBusy?'Ripristino in corso…':'Sostituisci tutto'}</button>`;
    box.querySelector('#bk_go').onclick = ()=>{
      if(box.querySelector('#bk_confirm').value.trim() !== S.workspace.name) return toast('Nome non corrispondente: non ho toccato niente.');
      restoreBackup(m.backup);
    };
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

  else if(m.type==='lesson-actions'){
    const [y,mo,dd] = m.date.split('-').map(Number);
    const dateLabel = `${WEEKDAYS[(new Date(y,mo-1,dd).getDay()+6)%7]} ${dd} ${MONTHS[mo-1]} ${y}`;
    const req = myAbsenceRequest(m.ref, m.date);
    const canAsk = !req || req.status==='rifiutata';
    const slot = !m.extra ? S.slots.find(x=>x.id===m.slotId) : null;
    box.innerHTML = `
      <div class="mhead"><h2>${esc(m.label)}</h2><button id="x">✕</button></div>
      <p class="hint" style="margin:0 0 14px">${esc(fmtHM(m.start))}–${esc(fmtHM(m.end))} · ${dateLabel}</p>
      <h3>Richiesta di assenza</h3>
      ${canAsk ? `
        ${req ? '<p class="hint" style="margin:0 0 8px">La richiesta precedente è stata rifiutata.</p>' : ''}
        <label class="field"><span>Motivo (facoltativo)</span><input type="text" id="ab_reason" placeholder="Es. visita medica"></label>
        <button class="btn block" id="ab_send">Chiedi di assentarti</button>
        <p class="hint">Tutti i membri ricevono un avviso; un amministratore conferma o rifiuta.</p>`
      : `<p class="hint" style="margin:0 0 8px">${req.status==='in_attesa' ? '⏳ Richiesta inviata, in attesa di conferma.' : '✅ Assenza approvata.'}</p>
        ${req.status==='in_attesa' ? '<button class="btn secondary block" id="ab_withdraw">Ritira richiesta</button>' : ''}`}
      ${isAdmin() && !m.extra ? `
        <h3 style="margin-top:22px">Annulla questa lezione</h3>
        <p class="hint" style="margin:0 0 10px">Vale solo per ${dateLabel}: le altre settimane restano invariate.</p>
        <label class="field"><span>Motivo (facoltativo)</span><input type="text" id="cl_reason" placeholder="Es. palestra chiusa"></label>
        <label class="checkrow"><input type="checkbox" id="cl_repl"><span>Sostituisci con una lezione extra</span></label>
        <div id="cl_fields" class="hidden">
          <label class="field"><span>Data</span><input type="date" id="cl_date" value="${m.date}"></label>
          <label class="field"><span>Etichetta</span><input type="text" id="cl_label" value="${esc(slot ? slot.label : m.label)}"></label>
          <div class="row">
            <label class="field grow"><span>Inizio</span><input type="time" id="cl_start" value="${fmtHM(m.start)}"></label>
            <label class="field grow"><span>Fine</span><input type="time" id="cl_end" value="${fmtHM(m.end)}"></label>
          </div>
        </div>
        <button class="btn danger block" id="cl_go">Annulla lezione</button>` : ''}`;
    const send = box.querySelector('#ab_send');
    if(send) send.onclick = ()=> requestAbsence(m.ref, m.date, box.querySelector('#ab_reason').value.trim());
    const withdraw = box.querySelector('#ab_withdraw');
    if(withdraw) withdraw.onclick = ()=> withdrawAbsence(req.id);
    const repl = box.querySelector('#cl_repl');
    if(repl) repl.onchange = ()=> box.querySelector('#cl_fields').classList.toggle('hidden', !repl.checked);
    const clGo = box.querySelector('#cl_go');
    if(clGo) clGo.onclick = ()=>{
      const replacement = repl.checked ? {
        date: box.querySelector('#cl_date').value, label: box.querySelector('#cl_label').value.trim(),
        start_time: box.querySelector('#cl_start').value, end_time: box.querySelector('#cl_end').value,
      } : null;
      if(confirm(replacement ? 'Annullare la lezione e creare quella sostitutiva?' : 'Annullare la lezione di questa data?')) cancelLesson(m.slotId, m.date, box.querySelector('#cl_reason').value.trim(), replacement);
    };
  }

  else if(m.type==='pay-settings'){
    const pay = Object.assign({}, DEFAULT_PAY, S.paySettings||{});
    // i tipi di lezione sono le etichette usate negli orari e nelle lezioni extra
    const labels = Array.from(new Map(S.slots.concat(S.reportData ? S.reportData.extras : [])
      .map(x=>[rateKey(x.label), x.label.trim()])).entries()).filter(([k])=>k).sort((a,b)=>a[1].localeCompare(b[1]));
    box.innerHTML = `
      <div class="mhead"><h2>Regole e tariffe</h2><button id="x">✕</button></div>
      <h3>Tariffa oraria per tipo di lezione</h3>
      <p class="hint" style="margin:0 0 10px">Il tipo è l'etichetta della lezione. Lascia vuoto per usare la tariffa predefinita.</p>
      ${labels.map(([k,l],i)=>`<label class="field rate"><span>${esc(l)}</span><input type="number" min="0" step="0.5" inputmode="decimal" data-rate="${esc(k)}" id="pr_${i}" value="${pay.rates[k]!=null ? esc(pay.rates[k]) : ''}" placeholder="${esc(pay.default_rate)}"> €/h</label>`).join('') || '<p class="hint">Nessun orario ancora.</p>'}
      <label class="field rate"><span>Tariffa predefinita</span><input type="number" min="0" step="0.5" inputmode="decimal" id="pr_default" value="${esc(pay.default_rate)}"> €/h</label>
      <h3 style="margin-top:18px">Regole</h3>
      <label class="field rate"><span>Compresenza: quota della tariffa a testa</span><input type="number" min="0" max="100" step="0.01" inputmode="decimal" id="pr_factor" value="${round2(pay.copresence_factor*100)}"> %</label>
      <p class="hint" style="margin:-6px 0 12px">66,67% = 2/3 della tariffa a ciascuno. 50% con due istruttori = tariffa divisa a metà.</p>
      <label class="checkrow"><input type="checkbox" id="pr_master" ${pay.master_takes_all?'checked':''}><span><b>Il maestro caposcuola prende tutto</b><small>Se è presente, il compenso della lezione va solo a lui e non si divide con gli istruttori.</small></span></label>
      <button class="btn block" id="pr_save">Salva</button>`;
    box.querySelector('#pr_save').onclick = ()=>{
      const rates = {};
      box.querySelectorAll('[data-rate]').forEach(i=>{ if(i.value!=='') rates[i.dataset.rate] = Math.max(0, Number(i.value)); });
      const factor = Number(box.querySelector('#pr_factor').value);
      if(!(factor>=0 && factor<=100)) return toast('La quota di compresenza va da 0 a 100%.');
      savePaySettings({rates, default_rate:Math.max(0, Number(box.querySelector('#pr_default').value)||0),
        copresence_factor:round2(factor)/100, master_takes_all:box.querySelector('#pr_master').checked});
    };
  }

  else if(m.type==='lesson-log'){
    const dt = new Date(m.date+'T00:00:00');
    const dateLabel = `${WEEKDAYS[(dt.getDay()+6)%7]} ${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
    const all = logsFor(m.ref, m.date);
    const others = all.filter(l=> l.instructor_id!==myProfileId());
    const mine = myLessonLog(m.ref, m.date);
    const othersHtml = others.length ? `
      <div class="col" style="gap:10px;margin-bottom:14px">
        ${others.map(l=>`<div class="logentry"><div class="logwho">${esc(instructorName(l.instructor_id))}</div><div class="logtext">${esc(l.content)}</div></div>`).join('')}
      </div>` : '';
    box.innerHTML = `
      <div class="mhead"><h2>Registro lezione</h2><button id="x">✕</button></div>
      <p class="hint" style="margin:0 0 12px"><b>${esc(m.label)}</b> · ${esc(fmtHM(m.start))}–${esc(fmtHM(m.end))} · ${dateLabel}</p>
      ${others.length ? `<h3 style="margin:0 0 6px">Altre voci</h3>${othersHtml}` : ''}
      <label class="field"><span>${mine?'La tua voce':'Aggiungi la tua voce'}</span>
        <textarea id="ll_text" rows="5" placeholder="Cosa avete fatto in questa lezione? (esercizi, argomenti, note...)">${mine?esc(mine.content):''}</textarea>
      </label>
      <button class="btn block" id="ll_save">${mine?'Salva modifiche':'Salva'}</button>
      ${mine?`<button class="btn ghost block" id="ll_del" style="margin-top:8px">Elimina la mia voce</button>`:''}`;
    box.querySelector('#ll_save').onclick = ()=> saveLessonLog(m.ref, m.date, box.querySelector('#ll_text').value);
    const del = box.querySelector('#ll_del');
    if(del) del.onclick = ()=>{ if(confirm('Eliminare la tua voce del registro?')) deleteLessonLog(mine.id); };
  }

  box.querySelector('#x').onclick = closeModal;
  return bg;
}

boot();

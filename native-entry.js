import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';

const CHANNELS = {
  attendance: {name:'Presenze e assenze', description:'Modifiche alle presenze e alle assenze'},
  recurring: {name:'Presenze ricorrenti', description:'Modifiche alle presenze settimanali ricorrenti'},
  schedule: {name:'Orari e lezioni', description:'Modifiche agli orari e alle lezioni extra'},
  calendar: {name:'Calendari', description:'Modifiche ai calendari e alle attivazioni'},
  lesson_log: {name:'Registri lezione', description:'Modifiche alle voci dei registri lezione'},
  members: {name:'Membri', description:'Modifiche ai membri e ai loro ruoli'},
};

function channelId(category){
  return `presencer_${CHANNELS[category] ? category : 'schedule'}`;
}

async function ensureChannels(){
  if(!Capacitor.isNativePlatform() || Capacitor.getPlatform()!=='android') return;
  await Promise.all(Object.entries(CHANNELS).map(([category, details])=>
    LocalNotifications.createChannel({
      id:channelId(category),
      name:details.name,
      description:details.description,
      importance:4,
      visibility:1,
      vibration:true,
      lights:true,
      lightColor:'#E86B00',
    })
  ));
}

function normalizePermission(value){
  if(value==='granted') return 'granted';
  if(value==='denied') return 'denied';
  return 'prompt';
}

/* ---------------- notifiche push (arrivano anche ad app chiusa) ----------------
   Il telefono si fa dare da Firebase un "recapito" (token) e l'app lo salva nel
   database. Da lì in poi è il server a spedire le notifiche, quindi non serve
   che l'app sia aperta. Senza google-services.json la registrazione fallisce e
   l'app continua a funzionare con le sole notifiche locali. */
let pushToken = null;
let pushListenersReady = false;
let pushWaiters = [];

function resolvePushWaiters(token, error){
  const waiters = pushWaiters;
  pushWaiters = [];
  waiters.forEach(({resolve, reject})=> error ? reject(error) : resolve(token));
}

function ensurePushListeners(){
  if(pushListenersReady) return;
  pushListenersReady = true;
  PushNotifications.addListener('registration', token=>{
    pushToken = token && token.value ? token.value : null;
    resolvePushWaiters(pushToken, null);
  });
  PushNotifications.addListener('registrationError', err=>{
    console.warn('Registrazione push non riuscita', err);
    resolvePushWaiters(null, null);   // niente push: l'app resta usabile
  });
}

window.PresencerNative = {
  isNative: Capacitor.isNativePlatform(),
  async checkPermission(){
    if(!Capacitor.isNativePlatform()) return 'unavailable';
    const result = await LocalNotifications.checkPermissions();
    return normalizePermission(result.display);
  },
  async requestPermission(){
    if(!Capacitor.isNativePlatform()) return 'unavailable';
    const result = await LocalNotifications.requestPermissions();
    if(result.display==='granted') await ensureChannels();
    return normalizePermission(result.display);
  },
  /* Chiede a Firebase il recapito di questo telefono. Restituisce il token
     oppure null se le push non sono disponibili (permesso negato, APK senza
     google-services.json, dispositivo senza servizi Google). */
  async registerPush(){
    if(!Capacitor.isNativePlatform()) return null;
    try{
      const permission = await PushNotifications.requestPermissions();
      if(permission.receive!=='granted') return null;
      await ensureChannels();
      ensurePushListeners();
      if(pushToken) return pushToken;
      const waiting = new Promise((resolve, reject)=> pushWaiters.push({resolve, reject}));
      await PushNotifications.register();
      // Se Firebase non risponde non blocchiamo l'accesso all'app.
      return await Promise.race([
        waiting,
        new Promise(resolve=> setTimeout(()=> resolve(null), 10000)),
      ]);
    }catch(err){
      console.warn('Push non disponibili', err);
      return null;
    }
  },
  async unregisterPush(){
    if(!Capacitor.isNativePlatform()) return;
    try{ await PushNotifications.unregister(); }catch(err){ console.warn(err); }
    pushToken = null;
  },
  async notify(event){
    if(!Capacitor.isNativePlatform()) return;
    await ensureChannels();
    const rawId = Number.parseInt(String(event.id), 10);
    const id = Number.isSafeInteger(rawId) ? (Math.abs(rawId) % 2147483646) + 1 : (Date.now() % 2147483646) + 1;
    await LocalNotifications.schedule({
      notifications:[{
        id,
        title:event.title || 'Presencer',
        body:event.body || 'Un evento è stato modificato.',
        channelId:channelId(event.category),
        // Sagoma monocromatica in barra di stato + icona a colori dell'app
        // nel pannello notifiche (Android non accetta un'icona piccola a colori).
        smallIcon:'ic_stat_presencer',
        largeIcon:'presencer_icon',
        extra:{eventId:String(event.id), category:event.category},
      }],
    });
  },
};


import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

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
        extra:{eventId:String(event.id), category:event.category},
      }],
    });
  },
};


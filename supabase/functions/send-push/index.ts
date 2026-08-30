// ============================================================================
//  send-push — invia le notifiche Presencer ai telefoni, anche ad app chiusa.
//
//  Viene chiamata dal trigger su app_events (migration_push_notifications.sql).
//  Gira sul server, quindi non dipende dall'app aperta.
//
//  Segreti richiesti (vedi PUSH_SETUP.md):
//    FIREBASE_SERVICE_ACCOUNT  il file JSON dell'account di servizio Firebase
//  Già presenti su Supabase, non serve impostarli:
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
//  Costo: zero. FCM è gratuito e illimitato, le Edge Function rientrano nel
//  piano gratuito Supabase.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/* ---------- autenticazione verso Firebase (OAuth2 con account di servizio) ---------- */

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pemToBinary(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const raw = atob(body);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// L'access token dura un'ora: lo teniamo tra un'invocazione e l'altra finché
// l'istanza resta calda, così non rifacciamo la firma ogni volta.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(account: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: account.client_email,
    scope: FCM_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBinary(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)),
  );
  const assertion = `${header}.${claims}.${b64url(signature)}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`OAuth Firebase fallito: ${JSON.stringify(payload)}`);

  cachedToken = { value: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
  return cachedToken.value;
}

/* ---------- invio ---------- */

Deno.serve(async request => {
  try {
    const { event_id } = await request.json();
    if (!event_id) return json({ error: 'event_id mancante' }, 400);

    const raw = Deno.env.get('FIREBASE_SERVICE_ACCOUNT');
    if (!raw) return json({ error: 'FIREBASE_SERVICE_ACCOUNT non configurato' }, 500);
    const account: ServiceAccount = JSON.parse(raw);

    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: event, error: eventError } = await db
      .from('app_events').select('*').eq('id', event_id).maybeSingle();
    if (eventError) throw eventError;
    if (!event) return json({ skipped: 'evento non trovato' });

    // Destinatari: i membri dello spazio, escluso chi ha fatto la modifica,
    // che hanno acceso le notifiche e non hanno silenziato questa categoria.
    const { data: members, error: membersError } = await db
      .from('profiles').select('id').eq('workspace_id', event.workspace_id);
    if (membersError) throw membersError;

    const recipients = (members ?? [])
      .map(m => m.id)
      .filter(id => id !== event.actor_profile_id);
    if (!recipients.length) return json({ sent: 0, reason: 'nessun destinatario' });

    const { data: prefs, error: prefsError } = await db
      .from('notification_preferences')
      .select(`profile_id, enabled, ${event.category}`)
      .in('profile_id', recipients);
    if (prefsError) throw prefsError;

    const wants = new Set(
      (prefs ?? [])
        .filter(p => p.enabled && (p as Record<string, unknown>)[event.category] !== false)
        .map(p => p.profile_id),
    );
    if (!wants.size) return json({ sent: 0, reason: 'nessuno ha le notifiche accese' });

    const { data: devices, error: devicesError } = await db
      .from('device_tokens').select('id, token').in('profile_id', [...wants]);
    if (devicesError) throw devicesError;
    if (!devices?.length) return json({ sent: 0, reason: 'nessun dispositivo registrato' });

    const accessToken = await getAccessToken(account);
    const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
    const stale: string[] = [];
    let sent = 0;

    await Promise.all(devices.map(async device => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: device.token,
            notification: { title: event.title, body: event.body },
            android: {
              priority: 'HIGH',            // consegna anche in Doze / app chiusa
              notification: {
                channel_id: `presencer_${event.category}`,
                icon: 'ic_stat_presencer',
                color: '#E86B00',
              },
            },
            data: { eventId: String(event.id), category: String(event.category) },
          },
        }),
      });

      if (response.ok) { sent++; return; }

      const body = await response.text();
      // App disinstallata o token rigenerato: il recapito non esiste più.
      if (response.status === 404 || body.includes('UNREGISTERED') || body.includes('INVALID_ARGUMENT')) {
        stale.push(device.id);
      } else {
        console.error('FCM ha rifiutato l\'invio:', response.status, body);
      }
    }));

    if (stale.length) await db.from('device_tokens').delete().in('id', stale);

    return json({ sent, removed: stale.length });
  } catch (error) {
    console.error(error);
    return json({ error: String(error) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

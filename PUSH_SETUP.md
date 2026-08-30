# Notifiche ad app chiusa — configurazione

Serve per ricevere le notifiche quando Presencer **non è aperta** (o è chiusa del tutto).

Il codice è già pronto. Restano tre cose che solo tu puoi fare, perché richiedono
i tuoi account. **Costo totale: zero**, e non viene chiesta nessuna carta di credito.

## Perché serve Firebase

Su Android l'unico modo per far arrivare una notifica ad app chiusa è passare dai
server di Google (FCM, Firebase Cloud Messaging): il telefono tiene aperto **un
solo** canale verso Google per tutte le app, ed è così che la batteria sopravvive.
Nessuna app può restare in ascolto per conto suo senza restare accesa in background.

FCM è gratuito e senza limiti di messaggi (piano **Spark**, quello predefinito).

Il percorso di una notifica diventa:

```
qualcuno modifica una presenza
   ↓
Supabase scrive una riga in app_events        (già esistente)
   ↓
il trigger chiama la Edge Function "send-push" (nuovo)
   ↓
la funzione chiede a Firebase di consegnare    (nuovo)
   ↓
il telefono mostra la notifica, app aperta o chiusa
```

---

## 1. Progetto Firebase (5 minuti)

1. Vai su [console.firebase.google.com](https://console.firebase.google.com) → **Aggiungi progetto**.
   Chiamalo `Presencer`. **Disattiva Google Analytics** (non serve e chiede altri consensi).
2. Nel progetto: **Aggiungi app** → icona Android.
   - *Nome pacchetto Android*: `it.presencer.app` — deve essere **esattamente** questo.
   - Registra l'app e **scarica `google-services.json`**.
3. Copia quel file in:

   ```
   android/app/google-services.json
   ```

   È tutto: il progetto Android lo rileva da solo, non serve toccare Gradle.

> Il file contiene solo identificativi pubblici del progetto, non è una password.
> Resta comunque fuori da Git per abitudine (vedi `.gitignore`).

## 2. Chiave per il server (2 minuti)

La Edge Function deve dimostrare a Firebase di essere autorizzata.

1. Firebase → ⚙️ **Impostazioni progetto** → scheda **Account di servizio**.
2. **Genera nuova chiave privata** → scarica il file JSON.
3. ⚠️ Questa **è** una password: non metterla mai nel repository né nell'APK.

## 3. Supabase (10 minuti)

Serve la CLI di Supabase (`npm install -g supabase`), poi:

```powershell
supabase login
```

```powershell
supabase link --project-ref xuhrhliwiocxrglhvfcj
```

### 3a. La chiave Firebase → segreto (dal sito, consigliato)

Il modo più semplice e senza rischi di errore: **non** passare dal terminale.

1. [Dashboard Supabase](https://supabase.com/dashboard/project/xuhrhliwiocxrglhvfcj/settings/functions)
   → **Edge Functions** → **Secrets** → **Add new secret**
2. Nome: `FIREBASE_SERVICE_ACCOUNT`
3. Valore: apri il file JSON scaricato al passo 2, seleziona **tutto** il contenuto
   e incollalo nel campo. Salva.

Il JSON contiene virgolette e a capo: dal terminale Windows verrebbero mangiati
dalle regole di escaping, ed è esattamente per questo che conviene il sito.

<details>
<summary>Se proprio preferisci il terminale (PowerShell)</summary>

Va compresso su una riga sola e passato tramite file, non come argomento:

```powershell
$json = (Get-Content "C:\percorso\della\chiave.json" -Raw) -replace "`r?`n",""
"FIREBASE_SERVICE_ACCOUNT=$json" | Out-File -Encoding utf8 .env.push
```

```powershell
supabase secrets set --env-file .env.push
```

```powershell
Remove-Item .env.push
```

L'ultimo comando **non va saltato**: quel file contiene la chiave privata.

</details>

### 3b. Pubblica la funzione

```powershell
supabase functions deploy send-push
```

### 3c. La migrazione

In **SQL Editor** esegui [`migration_push_notifications.sql`](migration_push_notifications.sql).

### 3d. Dire al database dove chiamare

Il trigger ha bisogno di due valori. Vanno nel **Vault** di Supabase: su Supabase
gestito il ruolo `postgres` non è superuser, quindi `alter database ... set`
viene rifiutato con `permission denied to set parameter`.

Nel SQL Editor, sostituendo `<SERVICE_ROLE_KEY>` con la chiave presa da
**Project Settings → API → `service_role`** (quella lunga, marcata *secret*):

```sql
delete from vault.secrets where name in ('push_functions_url','push_service_role_key');

select vault.create_secret(
  'https://xuhrhliwiocxrglhvfcj.supabase.co/functions/v1',
  'push_functions_url',
  'Indirizzo delle Edge Function per le notifiche push');

select vault.create_secret(
  '<SERVICE_ROLE_KEY>',
  'push_service_role_key',
  'Chiave con cui il trigger chiama send-push');
```

Verifica che siano entrambi presenti:

```sql
select name from vault.secrets where name like 'push_%';
```

> La `service_role` key resta **cifrata dentro il database**, non finisce mai
> nell'app né nel repository. Non confonderla con la chiave `anon` di `config.js`:
> quella è pubblica, questa no.

<details>
<summary>Alternativa senza SQL: Database Webhooks</summary>

Se preferisci l'interfaccia, puoi saltare i due `vault.create_secret` e il trigger:
**Database → Webhooks → Create a new hook**, tabella `app_events`, evento `Insert`,
tipo *Supabase Edge Functions*, funzione `send-push`, e aggiungi l'header
`Authorization: Bearer <SERVICE_ROLE_KEY>`.

In quel caso, nella migrazione, elimina il trigger per non spedire due volte:

```sql
drop trigger if exists trg_notify_push_on_event on app_events;
```

</details>

## 4. Ricompila l'APK

```bash
npm run apk:debug
```

Poi, sul telefono: Profilo → **Attiva notifiche**. Se tutto è a posto il messaggio
di conferma dice *"Notifiche attivate, anche ad app chiusa"*.

---

## Come provarlo

Chiudi Presencer sul telefono (proprio chiusa, non in secondo piano) e da un altro
dispositivo modifica una presenza. La notifica deve arrivare entro pochi secondi.

Se non arriva:

```bash
supabase functions logs send-push
```

I casi più comuni:

| Nel log | Significato |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT non configurato` | manca il passo 2 |
| `nessun dispositivo registrato` | il telefono non ha salvato il token: riapri l'app e riattiva le notifiche |
| `nessuno ha le notifiche accese` | il destinatario non ha attivato le notifiche nel suo profilo |
| nessun log | il trigger non parte: controlla i segreti con `select name from vault.secrets where name like 'push_%';` — se la lista è vuota, rifai il passo 3d |

## Costi

| Servizio | Piano | Limite | Costo |
|---|---|---|---|
| Firebase Cloud Messaging | Spark | nessun limite di messaggi | 0 € |
| Supabase Edge Functions | Free | 500.000 chiamate/mese | 0 € |
| Supabase Database + Auth | Free | già in uso | 0 € |

Una chiamata per ogni modifica: con qualche migliaio di modifiche al mese si resta
lontanissimi dai limiti. Nessun piano a pagamento viene attivato automaticamente:
al superamento dei limiti gratuiti i servizi si fermano, non si trasformano in fattura.

## Note

- **iPhone**: non è coperto. Le push su iOS richiedono un account Apple Developer
  a 99 €/anno, quindi sono fuori dal vincolo "gratis".
- **Xiaomi, Huawei, Samsung** e simili hanno risparmi energetici aggressivi che
  possono ritardare le notifiche. Se succede: Impostazioni → App → Presencer →
  Batteria → *Senza restrizioni*.
- **Senza `google-services.json`** l'app si compila e funziona lo stesso: restano
  le notifiche di quando l'app è aperta, esattamente come adesso.

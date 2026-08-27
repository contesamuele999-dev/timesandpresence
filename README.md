# Presencer

Web app semplice per gestire le presenze di istruttori (o dipendenti, o familiari) a lezioni/turni
organizzati per settimana, con calendari salvabili per periodo (Estate, Inverno, Extra...) e accessi
"usa e getta" senza registrazione.

Il client resta HTML/CSS/JS puro + [Supabase](https://supabase.com) (database + login). Funziona come
**PWA** e può anche essere compilato in un **APK Android** tramite Capacitor.

## 1. Crea il progetto Supabase (gratis)

1. Vai su [supabase.com](https://supabase.com) → crea un account → **New project**.
2. Una volta creato, vai su **SQL Editor** → **New query**, incolla tutto il contenuto di
   [`schema.sql`](schema.sql) e premi **Run**. Crea tabelle e permessi. Esegui poi anche
   [`migration_notifications.sql`](migration_notifications.sql) per attivare notifiche e preferenze granulari.
3. Vai su **Authentication → Providers → Email** e **disattiva "Confirm email"**.
   Serve per far funzionare la registrazione al volo, senza dover controllare la posta: pensata
   per chi non è pratico di tecnologia.
4. Vai su **Project Settings → API**: copia **Project URL** e **anon public key**.

## 2. Configura l'app

Apri [`config.js`](config.js) e incolla i due valori:

```js
window.SUPABASE_URL = 'https://xxxxx.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJ...';
```

Salva. Fatto: l'app è pronta.

## 3. Avvio

Serve un piccolo server statico (per motivi di sicurezza il browser non apre `fetch` da `file://`):

```bash
npx serve .
# oppure
python -m http.server 8080
```

Apri l'indirizzo mostrato (es. `http://localhost:8080`).

Per hosting reale gratuito basta caricare la cartella su [Netlify](https://netlify.com) (drag&drop) o
[Vercel](https://vercel.com) — nessuna build necessaria. Oppure usa GitHub Pages, vedi sotto.

## 4. Crea l'APK Android

Requisiti: Node.js 22+, JDK 21, Android Studio e Android SDK 36. Se il JDK non viene rilevato,
imposta `JAVA_HOME` sulla sua cartella. Poi esegui:

```bash
npm install
npm run apk:debug
```

L'APK di sviluppo viene creato in `android/app/build/outputs/apk/debug/app-debug.apk` e copiato anche
nella radice come `Presencer-debug.apk`. Per aggiornare il progetto Android senza compilare:

```bash
npm run android:sync
```

Il progetto nativo usa l'ID `it.presencer.app`, include l'icona Presencer e supporta Android 7 (API 24) o successivo.

## 5. Deploy su GitHub Pages

La cartella è già un repository git locale (primo commit fatto). Per pubblicarla:

1. Crea un repository **vuoto** su [github.com/new](https://github.com/new) (pubblico, senza
   README/licenza — sono già presenti in locale).
2. Collega il repository locale a quello remoto (una sola volta):
   ```bash
   git remote add origin https://github.com/TUO-UTENTE/TUO-REPO.git
   git push -u origin main
   ```
3. Su GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch `main`, cartella `/ (root)` → Save.
4. Dopo 1-2 minuti l'app è online su `https://TUO-UTENTE.github.io/TUO-REPO/`.

Da quel momento in poi, per pubblicare ogni modifica basta lanciare **`push-to-github.bat`**
(doppio click) nella cartella del progetto: aggiunge tutte le modifiche, crea un commit e fa il
push su `main` in automatico. Se non hai modifiche da pubblicare te lo dice e non fa nulla.

> Nota sicurezza: `config.js` contiene la chiave *anon* di Supabase e finisce nel repository
> pubblico — è previsto e sicuro: quella chiave è già visibile a chiunque apra l'app nel browser
> (Network tab), la vera protezione dei dati sono le regole RLS nel database, non la segretezza
> della chiave.

## Migrazioni (se hai già eseguito schema.sql in passato)

Esegui in ordine, una tantum, nell'SQL Editor di Supabase:

1. [`migration_multi_workspace.sql`](migration_multi_workspace.sql) — **necessaria**: senza questa
   l'accesso non funziona più (il codice ora richiede la colonna `user_id` su `profiles`). Abilita anche
   un account a gestire più spazi e include già la fix precedente per la lettura pubblica dei profili.
2. [`migration_workspace_mgmt_avatar.sql`](migration_workspace_mgmt_avatar.sql) — rinomina/elimina spazi,
   foto profilo.
3. [`migration_scheduling_recurring.sql`](migration_scheduling_recurring.sql) — cambio calendario
   programmato e presenza ricorrente.
4. [`migration_lesson_log.sql`](migration_lesson_log.sql) — registro lezione: gli istruttori possono
   scrivere cosa hanno fatto in ogni lezione.
5. [`migration_calendar_periods.sql`](migration_calendar_periods.sql) — timeline periodi di validità dei
   calendari: preserva gli orari e le presenze storiche nel passato e attiva automaticamente il nuovo calendario
   a partire dalla data programmata.
6. [`migration_notifications.sql`](migration_notifications.sql) — eventi in tempo reale, preferenze per utente
   e categorie di notifica separate.

## Come funziona

- **Crea spazio**: la prima persona registra il proprio "spazio" (palestra, azienda, famiglia...) e
  diventa amministratore. Riceve un **codice invito** da condividere con gli altri (scheda Istruttori).
- **Ho un codice**: chiunque altro si registra inserendo quel codice → entra come istruttore.
- **Accesso rapido (usa e getta)**: l'amministratore genera un link temporaneo (1/3/7 giorni) dalla
  scheda Istruttori. Chi apre il link inserisce solo il proprio nome e può subito segnare la presenza,
  senza creare un account.
- **Calendari & Periodi di validità**: l'amministratore crea calendari per periodo (Estate/Inverno/Extra/Personalizzato),
  imposta gli orari settimanali ricorrenti, e può programmarne l'attivazione a partire da una data specifica ("Programma cambio")
  oppure renderli attivi immediatamente ("Rendi attivo oggi").
- **Duplica calendario**: per creare un nuovo orario stagionale con 1 click, il pulsante **Duplica** clona un calendario esistente
  con tutti i suoi orari settimanali, consentendo di ritoccare solo le differenze e programmarne la partenza.
- **Presenze con risoluzione per data**: navigando tra le settimane nella vista Presenze (frecce, swipe da mobile, Oggi),
  l'app carica automaticamente il calendario attivo in quella specifica settimana. Le settimane passate conservano
  fedelmente i vecchi orari e tutte le presenze già registrate, mentre le settimane future a partire dalla data programmata
  mostrano il nuovo orario.
- **Più spazi con lo stesso account**: tocca il nome dello spazio in alto (o "Cambia o aggiungi spazio"
  nel Profilo) per vedere tutti gli spazi a cui appartieni, crearne uno nuovo, o entrare in un altro
  spazio con un codice invito — utile per chi gestisce più palestre/aziende/famiglie con un solo login.
- **Più amministratori**: dalla scheda Istruttori, un admin può promuovere un istruttore ad amministratore
  (o toglierlo) con il pulsante "Rendi admin" / "Rendi istruttore" sulla riga del membro.
- **Presenza ricorrente**: nella vista Presenze, il pulsante 🔁 su un orario ricorrente segna quell'orario
  come "presente ogni settimana" per te, senza doverlo spuntare manualmente. Puoi comunque segnare
  un'eccezione (assente) su una singola data toccando il pulsante di presenza di quel giorno.
- **Assenza esplicita**: il pulsante di presenza ora ha tre stati — non segnato, presente (✅), assente
  (❌) — così si distingue chi non ha ancora segnato nulla da chi ha segnato di non esserci. La presenza
  ricorrente vale solo dalla settimana corrente in poi (non riempie retroattivamente le settimane passate).
- **Registro lezione**: nella vista Presenze (personale), ogni lezione ha il pulsante 📝 per scrivere
  cosa è stato fatto in quella lezione in quella data (esercizi, argomenti, note). Ogni istruttore ha la
  propria voce; tutti i membri dello spazio possono leggere le voci di tutti, ma ognuno modifica solo le
  proprie (l'admin può eliminare qualsiasi voce). Un pallino con il numero sul 📝 indica quante voci ci
  sono già per quella lezione.
- **Notifiche granulari**: nel Profilo ogni utente può attivare o disattivare separatamente notifiche per
  presenze, ricorrenze, orari/lezioni, calendari, registri e membri. Le modifiche fatte dallo stesso utente
  non generano avvisi sul suo dispositivo. Nell'APK ogni categoria corrisponde anche a un canale Android.
- **Installa come app (PWA)**: quando il browser lo permette (Android/Chrome/Edge) compare in basso un
  pulsante "Installa"; su iPhone/iPad (Safari) il pulsante mostra le istruzioni per "Aggiungi a schermata
  Home". Il pulsante si può chiudere con ✕ e non ricompare più su quel dispositivo.
- **Ricordami**: nella schermata di accesso c'è la spunta "Ricordami su questo dispositivo" (attiva di
  default). Se disattivata, la sessione resta solo finché il browser è aperto (sessionStorage) e non
  persiste alla chiusura.

## Limiti noti / da valutare in futuro

- Rimuovere un istruttore toglie l'accesso allo spazio ma non cancella l'account Supabase sottostante.
- La "Vista di tutti" per l'amministratore è di sola consultazione (non permette di segnare la presenza
  al posto di un altro istruttore) — coerente con le policy di sicurezza (RLS) del database.
- Le notifiche di modifica usano Supabase Realtime e vengono mostrate mentre l'app è attiva; quando viene
  riaperta recupera gli eventi non ancora visti. Per consegna immediata anche ad app completamente chiusa
  serve aggiungere un provider push remoto (per esempio Firebase Cloud Messaging).

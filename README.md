# Presencer

Web app semplice per gestire le presenze di istruttori (o dipendenti, o familiari) a lezioni/turni
organizzati per settimana, con calendari salvabili per periodo (Estate, Inverno, Extra...) e accessi
"usa e getta" senza registrazione.

Nessuna build: HTML/CSS/JS puri + [Supabase](https://supabase.com) (database + login). Funziona anche
solo aprendo `index.html` con un piccolo server statico. È anche una **PWA**: si può installare su
telefono/computer come un'app vera (icona, schermo intero, apre da sola senza barra del browser).

## 1. Crea il progetto Supabase (gratis)

1. Vai su [supabase.com](https://supabase.com) → crea un account → **New project**.
2. Una volta creato, vai su **SQL Editor** → **New query**, incolla tutto il contenuto di
   [`schema.sql`](schema.sql) e premi **Run**. Crea tabelle e permessi.
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

## 4. Deploy su GitHub Pages

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
   programmato e presenza ricorrente (vedi sotto).

## Come funziona

- **Crea spazio**: la prima persona registra il proprio "spazio" (palestra, azienda, famiglia...) e
  diventa amministratore. Riceve un **codice invito** da condividere con gli altri (scheda Istruttori).
- **Ho un codice**: chiunque altro si registra inserendo quel codice → entra come istruttore.
- **Accesso rapido (usa e getta)**: l'amministratore genera un link temporaneo (1/3/7 giorni) dalla
  scheda Istruttori. Chi apre il link inserisce solo il proprio nome e può subito segnare la presenza,
  senza creare un account.
- **Calendari**: l'amministratore crea calendari per periodo (Estate/Inverno/Extra/Personalizzato),
  imposta gli orari settimanali ricorrenti, e sceglie quale calendario è "attivo" (quello mostrato di
  default). Tutti i calendari restano salvati e selezionabili dal menu a tendina in Presenze.
- **Presenze**: vista a settimana, un tocco per segnare "presente" su ogni lezione (swipe a
  sinistra/destra da mobile per cambiare settimana). Si possono aggiungere lezioni extra one-off
  (es. lezioni private) su una data specifica. Di default è mostrata la "Vista di tutti" (presenze di
  ogni istruttore e ospite), con un pulsante per passare alla vista personale.
- **Più spazi con lo stesso account**: tocca il nome dello spazio in alto (o "Cambia o aggiungi spazio"
  nel Profilo) per vedere tutti gli spazi a cui appartieni, crearne uno nuovo, o entrare in un altro
  spazio con un codice invito — utile per chi gestisce più palestre/aziende/famiglie con un solo login.
- **Cambio calendario programmato**: dalla scheda Calendari, un amministratore può programmare che un
  calendario diventi automaticamente attivo a una data futura ("Programma cambio"). Il controllo avviene
  lato client al primo accesso all'app da parte di un membro dello spazio a partire da quella data (non
  c'è un backend con cron, quindi non scatta se nessuno apre l'app quel giorno — scatterà al primo
  accesso successivo).
- **Più amministratori**: dalla scheda Istruttori, un admin può promuovere un istruttore ad amministratore
  (o toglierlo) con il pulsante "Rendi admin" / "Rendi istruttore" sulla riga del membro.
- **Presenza ricorrente**: nella vista Presenze, il pulsante 🔁 su un orario ricorrente segna quell'orario
  come "presente ogni settimana" per te, senza doverlo spuntare manualmente. Puoi comunque segnare
  un'eccezione (assente) su una singola data toccando il pulsante di presenza di quel giorno.
- **Assenza esplicita**: il pulsante di presenza ora ha tre stati — non segnato, presente (✅), assente
  (❌) — così si distingue chi non ha ancora segnato nulla da chi ha segnato di non esserci.

## Limiti noti / da valutare in futuro

- Rimuovere un istruttore toglie l'accesso allo spazio ma non cancella l'account Supabase sottostante.
- La "Vista di tutti" per l'amministratore è di sola consultazione (non permette di segnare la presenza
  al posto di un altro istruttore) — coerente con le policy di sicurezza (RLS) del database.
- Il cambio calendario programmato non scatta se nessuno apre l'app nel giorno previsto: scatta al primo
  accesso successivo di un membro registrato (non funziona per gli accessi ospite).

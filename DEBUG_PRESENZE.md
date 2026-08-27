# Debug presenze — 27 agosto 2026

## Causa riprodotta

Il trigger `record_presencer_event()` conteneva una singola condizione che
controllava il nome della tabella e poi accedeva a `NEW.name` e `NEW.role`.
PostgreSQL risolve quei riferimenti anche quando la tabella non è `profiles`.
Un inserimento in `attendance` falliva quindi con codice **42703**:
`record "new" has no field "name"`. La transazione veniva annullata.

Il test ha riprodotto lo stesso errore sia come istruttore sia subito dopo una
promozione ad admin. La correzione separa il controllo della tabella dall’accesso
ai campi del profilo. Le regole RLS sulle presenze non sono state allargate.

## Correzioni del client

- Nessuna presenza fittizia con ID `tmp_`: lo stato cambia dopo la conferma del server.
- Scritture di presenze e ricorrenze serializzate, con controlli disabilitati e indicazione di salvataggio.
- UPDATE e DELETE senza righe restituite non vengono più trattati come successi.
- Errori persistenti con codice, indicazioni per rete, sessione, permessi e migrazioni.
- Dopo una risposta di scrittura incerta è necessaria una rilettura prima di riprovare.
- Caricamento settimanale completo: nessuna risposta tardiva sovrascrive una settimana più recente.
- Gli errori di lettura non diventano silenziosamente una lista di presenze vuota.
- Ruolo aggiornato dagli eventi relativi al proprio profilo, al ritorno nell’app e con **Aggiorna dati**.
- La revoca del ruolo admin rimuove l’accesso alle schede di amministrazione nell’interfaccia.
- Eliminazione di lezioni extra disponibile soltanto al creatore o all’admin, con conferma del server.
- I registri della lezione vengono azzerati quando si cambia spazio.

**Tutti** rimane una vista di consultazione: anche gli admin modificano le proprie
presenze nella vista **Personale**. Non è stata aggiunta la delega per modificare le presenze altrui.

## Applicazione in produzione

1. Nel progetto Supabase dell’app, aprire **SQL Editor → New query**.
2. Eseguire tutto il file aggiornato `migration_notifications.sql`. È riapplicabile,
   opera in transazione e non cancella presenze, utenti o preferenze.
3. Pubblicare il client aggiornato, inclusi `app.js`, `index.html` e `sw.js`.
   Per Android occorre ricompilare e distribuire l’APK; la preparazione web da sola non aggiorna gli APK installati.
4. Riaprire l’app e premere **Aggiorna dati**. Provare su una propria presenza:
   non segnato → presente → assente → non segnato, verificando il risultato anche dopo un aggiornamento.

Il database di produzione non è stato letto né modificato durante questo debug.
Non sono stati eseguiti push, deploy o distribuzione di APK.

## Verifiche ripetibili

- `npm test`: test del client in Node e schema/policy/trigger SQL eseguiti su PostgreSQL in memoria con PGlite.
- `npm run prepare:web`: compilazione del bridge nativo e preparazione dei file web in `www/`.
- `npm run test:ui -- 8787`: anteprima dell’interfaccia con soli dati fittizi e pulsanti per simulare errore e promozione.
- Prove browser: attesa del salvataggio, errore 42703 senza perdita dello stato precedente,
  recupero con **Aggiorna dati** e comparsa delle schede admin dopo la promozione.

PGlite verifica il comportamento SQL, ma non sostituisce una verifica sulla versione
e sulle policy effettivamente installate nel progetto Supabase. L’anteprima usa un adapter
PostgREST fittizio e non certifica l’autenticazione o Realtime in produzione.

## Ulteriori rischi da affrontare separatamente

- Gli indici esistenti di `attendance` includono alternativamente `slot_id` o
  `extra_slot_id` a NULL: la loro unicità non protegge tutti gli inserimenti concorrenti
  da dispositivi diversi. Non è stata effettuata alcuna deduplicazione dei dati storici.
- Le policy di `profiles` consentono inserimento/aggiornamento del proprio profilo con
  verifiche ampie. Occorre rendere anche il controllo delle colonne `role` e `workspace_id`
  una responsabilità del server e rivedere i flussi di creazione/join; il controllo della UI non basta.
- I flussi di accesso rapido e le policy di lettura pubbliche richiedono un audit dedicato.
- `npm audit --omit=dev` non segnala vulnerabilità nelle dipendenze di produzione.
  L’audit completo segnala tre avvisi moderati nella catena di sviluppo
  `@capacitor/cli → xcode → uuid`, senza correzione automatica disponibile al momento della verifica.
  Non sono stati applicati aggiornamenti forzati delle dipendenze.

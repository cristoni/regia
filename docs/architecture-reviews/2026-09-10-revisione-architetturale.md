# Revisione architetturale — 10 settembre 2026

> **Stato: implementata per intero l'11 settembre 2026.** Tutte e cinque le
> proposte sono nel codice; `npm run typecheck` (cinque progetti, compresi da
> ora i test del motore) e `npm test` (237 test, 3 nuovi) verdi. Il controllo
> nuovo dei tipi ha portato alla luce due errori preesistenti nei test, mai
> visti prima — lo `Stato` finto con tre campi in meno, e due firme di
> overload invalide — entrambi corretti.

Revisione strutturale del motore e dell'interfaccia, condotta con il metodo dei
moduli profondi (Ousterhout): interfaccia piccola, implementazione grande, e il
sospetto verso tutto ciò che è largo e sottile. Ogni candidato è passato per
quattro controlli — Contrarian, Simplifier, Architect, Hacker — e qui arrivano
solo quelli sopravvissuti.

**Il giudizio d'insieme viene prima delle proposte: questo codice è
deliberatamente ben progettato.** La Sede è un modulo profondo da manuale, il
supervisore è coeso, le derivazioni dell'interfaccia sono pure e collaudate, i
commenti spiegano decisioni misurate e non parafrasano il codice. Non c'è un
solo `TODO` né un solo `any` in tutto `src/`. Le proposte che seguono sono
rifiniture su un impianto sano, non correzioni di rotta — e più di metà sono
**cancellazioni**.

---

## Proposta 1: Cancellare la metà "in memoria" di `LibreriaSuoni`

**Cosa:** eliminare `prepara()`, `preparaTutti()`, `ottieni()`, `campionati()`
e la mappa `memoria` da `LibreriaSuoni`; riscrivere `libreria.test.ts` contro
`assicura()`, che è l'interfaccia vera.

**Dove:** `src/engine/audio/libreria.ts` (righe 39–56, 124–181),
`src/engine/audio/libreria.test.ts` (interamente da riorientare),
`src/engine/index.ts:516` (la chiamata a `dimentica`, che diventa vuota).

**Perché:** la famiglia `prepara*` carica i campioni PCM **nel thread
principale** — esattamente ciò che l'architettura vieta ("il confine non
trasporta campioni", CLAUDE.md; "il thread principale non tiene in memoria un
solo campione", `index.ts:1061`). Una verifica d'uso mostra che **nessun codice
di produzione la chiama**: l'unico consumatore è `libreria.test.ts`. Il
commento su `prepara()` dice che serve "all'anteprima dalle cuffie del PC, e ai
test" — ma è stantio: l'anteprima usa `assicura()` (`index.ts:550`) e passa il
percorso a un lettore esterno. Ne segue anche che `dimentica()` in produzione è
un no-op: svuota una mappa che in produzione non si riempie mai. È il caso da
manuale dei "metodi che esistono solo per i test": i test collaudano
un'interfaccia che il prodotto non attraversa, e la copertura che sembrano dare
(conversione, cache, invalidazione, errori) va rifatta sul percorso vero.

**Come:** cancellare i quattro metodi e la mappa; togliere la chiamata a
`libreria.dimentica` da `suono.elimina` (il metodo sparisce con la mappa);
riscrivere i test usando `assicura()` — `durataMs` e `convertito` ci sono già,
e le asserzioni sui campioni (stereo/mono, PCM non nullo) si fanno leggendo il
`.pcm` dal percorso restituito. La copertura resta identica; cambia solo la
porta d'ingresso.

**Compromessi:**
- Pro: ~90 righe di implementazione in meno; l'interfaccia di `LibreriaSuoni`
  passa da 8 metodi a 4; sparisce l'unico varco da cui 31 MB di Sottofondo
  potrebbero rientrare nel thread principale.
- Contro: i test vanno riscritti (8 casi), e due asserzioni diventano un po'
  più verbose (leggere il file invece di guardare `campionato.campioni`).
- Rischio: basso. Il codice cancellato non ha chiamanti in produzione: il
  rischio è tutto nella riscrittura dei test, che i test stessi coprono.

**Sforzo:** piccolo (< mezza giornata).

**Note dei quattro controlli:**
- Contrarian: "magari `prepara` serve al tablet della Fase 3 o a un'anteprima
  futura?" — No: l'anteprima è già risolta con `assicura` + lettore esterno, e
  l'ADR 0004 fa del tablet un client WebSocket identico alla finestra.
- Simplifier: questa È la versione semplice. Approvata.
- Architect: allinea il codice all'architettura dichiarata invece di lasciarci
  dentro una strada che la contraddice.
- Hacker: "cancellala e basta" — esattamente questo.

---

## Proposta 2: Un solo caricamento dei Suoni, per l'avvio e per l'importazione

**Cosa:** assorbire in un metodo di `MotoreRegia` la sequenza "assicura tutti i
Suoni → carica nel thread audio → segna pronti → riavvia i Sottofondi", oggi
scritta due volte con **comportamenti d'errore diversi**.

**Dove:** `src/engine/index.ts` — `importa()` (righe 954–965) e `avviaMotore()`
(righe 1063–1075 e 1096–1101).

**Perché:** non è solo duplicazione: le due copie divergono dove conta. In
`avviaMotore` ogni `audio.caricaSuono` è dentro un `try/catch` — un file di
cache corrotto degrada a riga di Diario e l'avvio prosegue. In `importa()` la
stessa chiamata **non è protetta**: se fallisce a metà, l'eccezione risale dal
comando `progetto.importa` quando `this.progetto` è già stato sostituito e
riconfigurato — il client riceve un errore, ma il progetto è importato a metà,
con parte dei Suoni non caricati e i Sottofondi non ripartiti, e nessun
rollback. Aprire un progetto all'avvio e importarlo a caldo sono la stessa
operazione di dominio e oggi si comportano in due modi.

**Come:** un metodo (per esempio `caricaSuoniEavviaSottofondi()`) su
`MotoreRegia` con la semantica di `avviaMotore` — degrada e racconta, non
esplode — chiamato sia da `importa()` sia da `avviaMotore()` dopo la
costruzione del motore. `avviaMotore` perde ~35 righe; `importa` ~12.

**Compromessi:**
- Pro: un solo posto in cui il comportamento "Suono non caricabile" è deciso;
  l'importazione a caldo non può più lasciare lo stato a metà.
- Contro: cambia il comportamento osservabile di `progetto.importa` nel caso
  raro: prima falliva il comando, ora degrada con avviso a Diario. È il
  comportamento che l'avvio ha già.
- Rischio: basso; coperto da `index.test.ts` ("riaprendo, la configurazione è
  identica") più un test nuovo sull'importazione con un Suono rotto.

**Sforzo:** piccolo.

**Note dei quattro controlli:**
- Contrarian: "le due semantiche sono forse volute: all'importazione un errore
  duro dice subito che qualcosa non va" — ma l'errore duro arriva **dopo** la
  sostituzione del progetto, quindi non protegge niente: certifica uno stato a
  metà. L'asimmetria è accidentale.
- Simplifier: il metodo condiviso è più corto della somma delle copie.
- Architect: è "assorbire la logica del chiamante nel modulo": `avviaMotore`
  smette di conoscere i dettagli del caricamento.
- Hacker: nessuna obiezione.

---

## Proposta 3: I metodi di `Motore` smettono di essere facoltativi

**Cosa:** rendere obbligatori i sei metodi oggi opzionali dell'interfaccia
`Motore` (`interessatoVideo?`, `ultimoIdr?`, `elencoRegistrazioni?`,
`importaSuono?`, `esportaProgetto?`, `importaProgettoDaTesto?`).

**Dove:** `src/engine/api/servitore.ts` (interfaccia, righe 28–62, e i sei
punti d'uso con `?.`), `src/engine/api/servitore.test.ts` (`MotoreFinto`
guadagna sei metodi a una riga).

**Perché:** l'opzionalità permette al servitore di **mentire**. Con un motore
senza `importaSuono`, `POST /api/suoni` risponde `{"ok":true}` senza aver
importato niente (`servitore.ts:315`); lo stesso per `POST /api/progetto`
(`:328`). In pratica non succede — l'unico motore vero implementa tutto — ma il
contratto oggi ammette un'implementazione che accetta file e li butta,
rispondendo bene. Esiste un solo adattatore di produzione: l'opzionalità non
modella una variabilità reale, modella la pigrizia dello stub di test, che con
sei righe in più sparisce.

**Come:** togliere i `?` dall'interfaccia, sostituire i sei `?.`/`?? []` nel
servitore con chiamate dirette, aggiungere a `MotoreFinto` sei implementazioni
minime (che rendono anche i test degli endpoint HTTP scrivibili, oggi
impossibili contro lo stub).

**Compromessi:**
- Pro: il contratto non ammette più il successo silenzioso su un no-op; sei
  rami condizionali in meno nel servitore.
- Contro: `MotoreFinto` cresce di sei righe; un eventuale futuro "motore
  ridotto" dovrebbe implementare tutto (oggi non ne esiste nessuno).
- Rischio: minimo; il typecheck guida tutta la modifica.

**Sforzo:** piccolo (< un'ora).

**Note dei quattro controlli:**
- Contrarian: "l'opzionalità è il modo di dire quali capacità sono
  facoltative" — ma un server che risponde ok a un'importazione mai avvenuta
  non è una capacità in meno: è una bugia. Se un giorno servirà un motore
  parziale, il posto per dirlo è una risposta 501, non un `?.`.
- Simplifier: meno rami nel servitore, sei righe nello stub: bilancio positivo.
- Architect: è restringere l'interfaccia nel senso di Ousterhout — meno stati
  possibili da considerare per chi legge il servitore.
- Hacker: nessuna obiezione.

---

## Proposta 4: Collaudare i tipi anche nei test del motore

**Cosa:** un progetto TypeScript per i test del motore
(`tsconfig.engine-test.json`), aggiunto a `npm run typecheck`.

**Dove:** nuovo `tsconfig.engine-test.json`; `package.json` (script
`typecheck`); le correzioni che il controllo farà emergere nei
`src/engine/**/*.test.ts`.

**Perché:** oggi `src/engine/**/*.test.ts` è **escluso da tutti e quattro** i
progetti TypeScript: `npm run typecheck` non li guarda, e `tsx` toglie i tipi
senza controllarli. Non è teorico: `statoFinto()` in `servitore.test.ts:17`
dichiara di restituire `Stato` ma **mancano tre campi obbligatori**
(`impostazioni`, `ambiente`, `latenzaAttesaMs`) — un errore di tipo che nessuno
ha mai visto. Funziona per caso, perché il servitore serializza qualunque cosa
riceva; ma vuol dire che i test collaudano il contratto con un contratto falso,
e che chi aggiunge un campo a `Stato` non viene avvisato che lo stub è rimasto
indietro. I test dell'interfaccia questo problema l'hanno già risolto — con
`tsconfig.ui-test.json`, per la stessa ragione scritta nel suo commento — quindi
la proposta estende una scelta già fatta, non ne inventa una nuova.

**Come:** `tsconfig.engine-test.json` che estende `tsconfig.engine.json` con
`noEmit: true` e include solo i `*.test.ts`; quinta voce nello script
`typecheck`; poi correggere ciò che emerge (almeno `statoFinto`, più l'ignoto —
è la natura di questo intervento).

**Compromessi:**
- Pro: il contratto `Stato`/`Comando` torna sorvegliato anche dal lato test; le
  regressioni da "stub rimasto indietro" diventano errori di compilazione.
- Contro: `typecheck` si allunga di qualche secondo; le correzioni iniziali
  hanno una superficie non nota in anticipo.
- Rischio: basso — il rischio vero era quello attuale, il contratto falso.

**Sforzo:** piccolo, con una coda incerta (le correzioni che emergono).

**Note dei quattro controlli:**
- Contrarian: "i test si collaudano eseguendoli" — l'esecuzione non controlla
  le forme: `statoFinto` gira da mesi con tre campi in meno.
- Simplifier: un file di configurazione e una voce di script.
- Architect: sorveglia la giuntura da cui dipende tutto il prodotto
  (interfaccia ↔ motore via `Stato`).
- Hacker: economico, rende subito.

---

## Proposta 5: Un solo tipo `Livello` per il Diario

**Cosa:** dichiarare una volta `type Livello = 'info' | 'attenzione' | 'grave'`
e usarla nei dodici punti in cui oggi l'unione è riscritta a mano.

**Dove:** `src/engine/api/protocollo.ts` (dichiarazione, ed è già il posto
giusto: è il contratto che l'interfaccia importa); i dodici siti trovati con
una ricerca esatta — `index.ts` (×2), `supervisore.ts`, `gestore.ts`,
`registratore.ts`, `motore-audio.ts`, `gestore-audio.ts`,
`protocollo-audio.ts`, `protocollo.ts` (×2), `ui/nucleo/viste.ts` (che oggi la
dichiara per conto suo), `ui/schermate/setup.ts`.

**Perché:** dodici copie della stessa unione sono dodici occasioni di divergere
il giorno in cui i livelli cambiano, e il tipo esiste già — ma dichiarato
nell'interfaccia (`viste.ts:134`), cioè nel posto da cui il motore non può
importarlo. È la più piccola delle cinque proposte, e sta qui perché tocca il
vocabolario del sistema, non per il peso.

**Come:** `export type Livello` in `protocollo.ts`; le firme `suDiario` e i
tipi inline lo importano; `viste.ts` lo ri-esporta per compatibilità con le
schermate che già lo importano da lì.

**Compromessi:**
- Pro: il vocabolario del Diario ha una casa sola; una modifica futura tocca un
  punto invece di dodici.
- Contro: qualche import in più; `protocollo-audio.ts` prende una dipendenza
  (di soli tipi) da `api/protocollo.ts`.
- Rischio: nullo — è un'operazione di soli tipi, il compilato non cambia.

**Sforzo:** minuscolo.

**Note dei quattro controlli:**
- Contrarian: "le unioni inline sono autosufficienti; il tipo condiviso accoppia
  i moduli" — l'accoppiamento al contratto c'è già (il supervisore importa
  `StatoServer` dallo stesso file), e un'unione di tre letterali non è un posto
  dove l'autosufficienza compri qualcosa.
- Simplifier / Architect / Hacker: nessuna obiezione.

---

## Candidati esaminati e scartati

Stanno qui perché il loro scarto è un'informazione: chi rileggerà questo
documento non deve rifare l'analisi.

- **Spezzare lo `switch` di `MotoreRegia.esegui()` (~370 righe).** Sembra il
  candidato ovvio ed è quello sbagliato: l'interfaccia è un metodo solo, i casi
  sono corti, l'esaustività è verificata dal compilatore (`never`), e il file
  dichiara — a ragione — di essere il posto dove il dominio decide. È un modulo
  **profondo**: interfaccia minima, implementazione grande. Spezzarlo sarebbe
  churn.
- **Estrarre la gestione delle password in un modulo `Portachiavi`.** La
  memoria del fallimento (la stringa vuota come sentinella) meriterebbe test
  diretti, e oggi è collaudabile solo attraverso l'intero motore. Ma due
  controlli su quattro l'hanno bocciata: il codice è coeso dov'è, documentato
  riga per riga, e l'estrazione sarebbe churn a beneficio quasi solo dei test.
  Da riconsiderare se quella logica dovesse cambiare davvero.
- **Estrarre `stato()` come proiezione pura.** Le derivazioni dell'interfaccia
  sono pure e collaudate in `viste.ts`; la proiezione del motore è la stessa
  specie di codice ma è già coperta dai test d'insieme attraverso la giuntura
  vera (WebSocket). Estrarla creerebbe un'interfaccia il cui unico scopo è farsi
  collaudare.
- **Unificare i due `attendi()`** (supervisore, gestore Telecamere). Tre righe
  ciascuno: un modulo condiviso costerebbe più della duplicazione.

---

## Nota di metodo

Le proposte 1–5 condividono una direzione: **restringere interfacce che si sono
allargate oltre l'uso reale** (1, 3, 5) e **chiudere due giunture in cui il
sistema può mentire senza che nessuno se ne accorga** (2, 4). Nessuna aggiunge
un'astrazione nuova; tre cancellano codice. È la forma di intervento giusta per
un codice che è già in buona salute.

---

## Decisioni dopo il grill incrociato (Claude ↔ Codex, 11 settembre 2026)

Il documento è passato per due flussi indipendenti: Claude ha interrogato Codex
nel ruolo dell'autore (otto domande), e Codex ha generato dieci domande sue a
cui Claude ha risposto da autore. Entrambi hanno ispezionato il repository.
Esiti, per proposta:

- **P1** `[CONSENSO]` — Lo scopo è rimuovere l'interfaccia che esiste solo per
  i test, non garantire "zero PCM nel thread principale": la lettura transitoria
  durante la conversione è accettabile. Le asserzioni sui campioni si
  conservano leggendo il `.pcm` dal percorso di `assicura()`; spariscono solo
  quelle sulla mappa `memoria`. **Bonus dal grill:** con `prepara()` cancellata,
  `decodifica()` non ha più nessun motivo di restituire i byte — può misurare
  il file con `stat` e risparmiare la lettura intera (31 MB per un Sottofondo)
  alla prima importazione.
- **P2** `[CONSENSO, ampliata]` — Semantica unificata: si degrada per Suono,
  il progetto importato resta, ogni fallimento è una riga `attenzione` nel
  Diario; il ripiego "prepara-poi-scambia" con rollback è stato considerato e
  scartato (la convalida di schema e invarianti avviene già prima dello
  scambio; il rollback comprerebbe complessità per uno stato — Suono non
  pronto — che l'avvio già tratta come normale). **Il grill ha trovato un buco
  vero (domanda B5):** all'importazione la cache Suoni del thread audio non
  viene svuotata, quindi un id riusato dal progetto nuovo il cui file non si
  carica farebbe suonare **l'audio del progetto vecchio**. Correzione inclusa:
  si scaricano i Suoni vecchi prima di caricare i nuovi, e il riavvio dei
  Sottofondi è vincolato a `suoniPronti`. Il test di regressione deve forzare
  il fallimento di `caricaSuono` **dopo** una decodifica riuscita — per
  renderlo scrivibile, i parametri del costruttore di `MotoreRegia` diventano
  tipi strutturali (`Pick<…>`), che è a sua volta "accetta le dipendenze"
  fatto bene.
- **P3** `[CONSENSO]` — Metodi obbligatori, nessuna guardia a runtime (501):
  il compilatore è la guardia, e il caso "motore parziale" non esiste. Il
  dubbio di Codex sui consumatori esterni si risolve con un fatto: il
  repository non ha remote e il pacchetto è `private` — non ci sono
  consumatori esterni per costruzione. In più (domanda B8): con lo stub
  completo, gli endpoint HTTP di importazione diventano collaudabili, e un
  paio di test si aggiungono.
- **P4** `[CONSENSO]` — `include` solo i `*.test.ts` con `exclude: []` per
  scavalcare l'esclusione ereditata e `noEmit: true`: i sorgenti entrano da
  soli via import (verificato da Codex col compilatore: 16 radici di test più
  32 sorgenti, nessuna emissione). Perimetro delle correzioni: **solo i
  fixture di test**; un eventuale bug di prodotto scoperto strada facendo si
  corregge qui solo se piccolo e direttamente legato, altrimenti diventa una
  issue separata.
- **P5** `[DEFAULT PLAUSIBILE]` — Entrambi i flussi hanno sollevato
  l'alternativa `dominio/progetto.ts`. Si conferma `api/protocollo.ts`: i
  livelli del Diario sono vocabolario di comunicazione (righe di Diario,
  avvisi), non configurazione persistita, e la direzione di import
  motore→contratto esiste già (`StatoServer`).

Fuori perimetro, emerso dal grill: l'intreccio di comandi concorrenti durante
un'importazione lunga (domanda B6) è una condizione preesistente coperta
dall'assunzione di un solo Operatore, e non cambia con queste proposte; il
motore continua a non imporre il confine Setup/Evento (domanda B4), coerente
con la scelta già scritta nel protocollo per `impostazioni.audio`.

Rapporto di ambiguità dopo la fusione:

```
Goals:        0.10  ✓ chiaro
Acceptance:   0.10  ✓ chiaro
Boundaries:   0.25  ⚠ residuo minore (concorrenza fuori perimetro, annotata)
Alternatives: 0.25  ⚠ due default plausibili documentati (rollback, casa di Livello)
Assumptions:  0.25  ⚠ divergenza P2 dedotta dalla storia git, non provata
──────────────────────────────
Aggregato:    0.19  ✓ sotto la soglia (0.3)
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

**Regia** è un'applicazione Windows che controlla l'audio e il video di una casa degli orrori:
telefoni Android come altoparlanti (via Snapcast/Snapdroid) e come telecamere (via
DigitallyRefined/android-ip-camera), comandati da un unico PC.

`project.md` è il documento del committente. **Non è la verità corrente**: contiene errori di
fatto e criteri irraggiungibili trovati durante l'analisi. Quando `project.md` e
`docs/scostamenti-dal-documento-di-progetto.md` sono in disaccordo, vince il secondo.

## Comandi

```bash
npm test                      # 200 test. Concorrenza 1: ogni motore avvia un thread audio
npm run typecheck             # engine, shell, interfaccia, test dell'interfaccia
npm run build                 # interfaccia + motore + guscio
npm run dev                   # compila l'interfaccia e avvia Regia senza finestra, su :7333

# un solo file di test
node --import tsx --test src/engine/audio/mixer.test.ts
# un solo test, per nome
node --import tsx --test --test-name-pattern="sei ore" src/engine/audio/cadenza.test.ts
```

I test girano con il loader `tsx`, non con lo strip-types di Node: gli import interni usano
l'estensione `.js` (convenzione NodeNext) anche se i file sono `.ts`.

**Regia si avvia anche senza Electron**: `npx tsx src/engine/avvia.ts --porta 7333 [--rete]`
serve l'interfaccia vera su HTTP, ed è il modo più rapido per pilotarla da script e guardarla
insieme. `--rete` la espone a tutta la LAN invece che a loopback (è il tablet della Fase 3).

## Il banco di prova (richiede WSL)

Snapserver non gira nativo su Windows (ADR 0002), quindi il collaudo passa da una distro WSL.

```bash
npm run banco:prepara         # scarica snapserver+snapclient 0.35 nella distro, versione fissata
npm run banco:conf -- Ingresso Cantina Soffitta > /tmp/rg.conf
wsl -d Ubuntu -u root -e bash -lc 'cat > /tmp/regia/snapserver.conf' < /tmp/rg.conf
wsl -d Ubuntu -u root -e bash -lc \
  'setsid /opt/snapserver-0.35/usr/bin/snapserver -c /tmp/regia/snapserver.conf \
   > /tmp/regia/server.log 2>&1 < /dev/null & disown'

npx tsx banco/altoparlanti-finti.ts 4   # Altoparlanti finti DENTRO la distro
npm run banco:riconcilia                # riconciliatore contro il server vero
# HOST_FLUSSI va all'indirizzo della distro: su loopback gli inoltri di WSL
# sopravvivono al server morto e il banco misurerebbe un Flusso dentro un fantasma.
HOST_FLUSSI=$(wsl -d Ubuntu hostname -I | cut -d' ' -f1) \
  npm run banco:carico -- 40            # blocca il thread principale, verifica che l'audio regga
```

`setsid` è obbligatorio: senza, snapserver riceve SIGHUP e muore appena esce il `wsl.exe` che l'ha
lanciato, e `nohup` da solo non basta. Gli Altoparlanti finti girano **dentro la distro** perché il
`snapclient.exe` per Windows non si sincronizza con un server Linux — riporta uno scarto d'orologio
di un epoch Unix e scarta ogni chunk.

## Architettura

**Il motore è headless.** Non importa niente di Electron. Espone stato, comandi e video su
WebSocket locale (`/regia`); la finestra Electron è "un browser dedicato" che apre quell'indirizzo,
e il tablet della Fase 3 sarà un secondo client identico. Lo stato viaggia come **istantanea
completa** ogni 100 ms, non come differenze: con 12 Zone sono pochi kilobyte e non può
desincronizzarsi. I test d'insieme pilotano il motore da script, senza interfaccia.

**L'interfaccia non ha un framework, ed è una scelta.** L'istantanea arriva dieci volte al
secondo: un framework che ricostruisce l'albero a ogni istantanea distruggerebbe i `<canvas>` delle
Telecamere, e con loro il `VideoDecoder` che ci sta dietro — un secondo di nero per cella, dieci
volte al secondo. Si costruisce una volta e si aggiorna in posto, con `Elenco` (`src/ui/nucleo/dom.ts`)
a tenere allineate le liste per chiave. Le derivazioni pure stanno in `src/ui/nucleo/viste.ts` e
sono le uniche cose dell'interfaccia che si collaudano; il codice che tocca il DOM è sottile
apposta. **File caricati dall'interfaccia (Suoni, progetto) viaggiano come byte su HTTP**, non
come percorsi: con `sandbox: true` un `<input type=file>` non dà il percorso vero, e il tablet non
ha nemmeno lo stesso disco.

**Tre processi/thread, e il confine fra loro conta:**

| | dove | cosa |
|---|---|---|
| thread principale | Node/Electron | progetto, comandi, HTTP/WS, RPC Snapcast, video, ffmpeg |
| thread audio | `worker_thread` | tutti i mixer, tutti gli scrittori TCP, i campioni PCM |
| snapserver | processo in WSL | distribuisce l'audio ai telefoni |

Il thread audio esiste per una misura, non per gusto: con i mixer sul thread principale lo
scrittore restava indietro di oltre mezzo secondo sotto carico e perdeva Flusso. Il confine **non
trasporta campioni** — i Suoni li legge il thread audio dalla cache `.pcm` su disco.

**Il file di progetto è la verità, Snapcast è una proiezione** (ADR 0005). Le associazioni
client→Zona vivono in `progetto.json`; `riconciliatore.ts` è una funzione pura che confronta il
voluto con l'osservato e produce azioni RPC, da riapplicare finché il piano non è vuoto (togliere
un client da un gruppo gliene crea uno nuovo con id imprevedibile).

**Dodici Zone vogliono tredici Flussi.** Il tredicesimo è quello dei "non assegnati", e gli serve
un mixer vivo come agli altri: senza scritture la `async_read` di snapserver resta pendente e si
completa minuti dopo con un riferimento temporale vecchio.

### Convenzioni

- **Il dominio si scrive in italiano, la meccanica in inglese.** Zona, Altoparlante, Telecamera,
  Suono, Effetto, Sottofondo, Flusso, Identifica. `CONTEXT.md` è il glossario e va tenuto
  aggiornato; è deliberatamente privo di dettagli implementativi.
- **Gli schemi Zod in `src/engine/dominio/progetto.ts` sono la sola fonte di verità dei tipi**:
  i tipi TypeScript sono inferiti da lì, così non possono divergere dalla validazione.
- L'appartenenza a una Zona vive **sul dispositivo**, non come elenco nella Zona: l'invariante
  "appartiene a una sola Zona" è così vera per costruzione.

## Le tre fonti di documentazione

- **`docs/fatti-verificati.md`** — leggerlo **prima** di cambiare qualunque cosa tocchi Snapcast,
  WSL, ffmpeg o le telecamere. Ogni riga è marcata `[sorgente]` (letto nel codice upstream),
  `[misurato]` (eseguito su questa macchina) o `[surrogato]` (misurato su un sostituto, da rifare).
  Quando il codice sembra strano, la ragione è quasi sempre lì.
- **`docs/adr/`** — dieci decisioni, ciascuna con le alternative scartate e perché. Alcune sono
  state **corrette dopo la ricerca**: la correzione è in fondo al file, non sostituisce il testo.
- **`docs/scostamenti-dal-documento-di-progetto.md`** — errori e criteri irraggiungibili di
  `project.md`, da riportare al committente.

Quando una decisione nuova è difficile da invertire, sorprendente e frutto di un compromesso vero,
si aggiunge un ADR. Quando si misura qualcosa, si aggiunge una riga ai fatti verificati.

## Vincoli che sembrano dettagli e non lo sono

- **`send_to_muted = true` è obbligatorio.** "Identifica" mette in muto gli altri client del gruppo
  (ADR 0006); col default `false` uscirebbero dal flusso e si risincronizzerebbero al riaccenderli.
- **Ogni scrittura verso snapserver dev'essere multipla di un frame** (4 byte a 16 bit stereo).
  Una scrittura disallineata inverte L e R per il resto della vita della connessione.
- **`connect()` che riesce non prova che snapserver stia leggendo**: accetta una sola connessione
  per porta e il kernel parcheggia le altre. Una sola socket per porta, sempre. Vale anche per la
  **porta di controllo**: la prova che snapserver c'è è una risposta a `Server.GetStatus`, non una
  connessione aperta.
- **Si parla alla distro per indirizzo IP, mai a `127.0.0.1`** (ADR 0010). Gli inoltri che WSL
  crea su loopback **sopravvivono al processo che ascoltava**: `connect()` riesce, i byte partono,
  non li legge nessuno. E `0.0.0.0` contiene `127.0.0.1`, quindi un ponte che inoltra lì parla con
  se stesso.
- **Uno stream `idle` non vuol dire che non arrivano byte: vuol dire che arriva silenzio.** A casa
  vuota tutti gli stream sono `idle` ed è giusto così. Il criterio «passano a `playing`» vale
  mentre si suona qualcosa.
- **In bash `&` ha precedenza più bassa di `&&`**: `mkdir -p X && setsid ... &` manda in background
  anche il `mkdir`, la shell esce, e non succede niente — senza errori e con esito zero.
- **Il ritmo di scrittura lo detta l'orologio monotono, mai l'attesa di `drain`.** Scrivere finché
  arriva contropressione fa crescere la finestra TCP fino a secondi di audio in volo, senza errori.
- **L'anticipo di scrittura si somma al `buffer`**: la latenza pulsante→suono è
  `latenzaAttesaMs()`, non `bufferMs`.
- **Su Windows la risoluzione dei timer è 15,6 ms**: `setTimeout(20)` dorme ~31 ms. Non svegliarsi
  a ogni blocco.
- **Non chiamare `unref()` sul thread audio**: il processo si chiuderebbe mentre lo aspetta.

## Note operative

Gli heredoc di bash si rompono sui contenuti TypeScript di questo progetto: per scrivere o
modificare file usa gli strumenti dedicati, o uno script Python su file.

## Import da altri agenti

C'è una configurazione Codex in `~/.codex/config.toml`. Se vuoi importarne gli elementi
(server MCP, comandi, subagent, skill, istruzioni), rispondi `/import` per vedere cosa è
importabile, poi `/import --yes=<digest>` con il digest indicato dalla scansione.

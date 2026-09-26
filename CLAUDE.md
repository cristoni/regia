# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

**Regia** controlla l'audio e il video di una casa degli orrori: telefoni Android come
altoparlanti (via Snapcast/Snapdroid) e come telecamere (via
DigitallyRefined/android-ip-camera), comandati da un unico PC.

Gira **su Windows e su Linux**, e la differenza che conta sta in un posto solo: la **Sede**,
cioè la macchina dove gira snapserver — una distro WSL su Windows, il PC stesso su Linux
(ADR 0011). `src/engine/snapcast/sede.ts` è l'unico posto in cui il motore decide *dove gira
snapserver*; supervisore, riconciliatore e thread audio parlano a una `Sede` e non sanno quale
delle due sia. C'è un secondo posto che guarda `process.platform` e va nominato perché non è
dello stesso genere: `src/engine/ambiente.ts`, che non decide niente ma **lo dice** — è da lì
che esce il campo `piattaforma` di `AmbienteVivo`, quello che l'interfaccia non può dedurre dal
proprio ambiente perché il tablet della Fase 3 non gira sulla macchina del motore. Altrove
`process.platform` compare ancora, ma per domande diverse e piccole (il nome del binario di
ffmpeg, il lettore dell'anteprima, DPAPI, il comando che apre una cartella).
**La Sede locale è stata eseguita su un kernel Linux vero, non su una macchina Linux vera**: la
prova del 10 settembre 2026 gira dentro la distro `Ubuntu` di questa macchina — snapserver
nativo, nessun `wsl.exe` — ma senza telefoni, senza pacchetto e senza sessione desktop. Le righe
`[sorgente]` e `[misurato]`, e l'elenco di ciò che resta da provare, stanno in fondo a
`docs/fatti-verificati.md`.

`project.md` è il documento del committente. **Non è la verità corrente**: contiene errori di
fatto e criteri irraggiungibili trovati durante l'analisi. Quando `project.md` e
`docs/scostamenti-dal-documento-di-progetto.md` sono in disaccordo, vince il secondo.

## Comandi

```bash
npm test                      # 310 test; 5 si saltano senza ffprobe nel PATH (registrazione). Il
                              # resto usa l'ffmpeg di vendor/. Concorrenza 1: ogni motore avvia un
                              # thread audio. Su Linux NON deve esserci uno snapserver vivo su 1705,
                              # nemmeno orfano: la suite non esce (fatti verificati, 18 settembre)
npm run typecheck             # engine, shell, interfaccia, test dell'interfaccia
npm run build                 # interfaccia + motore + guscio
npm run dev                   # compila l'interfaccia e avvia Regia senza finestra, su :7333

npm run ffmpeg:prendi         # 133 MB in vendor/ffmpeg, non versionati. Da fare una volta
npm run dist:win              # build + electron-builder -> out/ (portabile + installer NSIS)
npm run dist:linux            # build + electron-builder -> out/ (AppImage + tar.gz). Da Linux

# un solo file di test
node --import tsx --test src/engine/audio/mixer.test.ts
# un solo test, per nome
node --import tsx --test --test-name-pattern="sei ore" src/engine/audio/cadenza.test.ts
```

I test girano con il loader `tsx`, non con lo strip-types di Node: gli import interni usano
l'estensione `.js` (convenzione NodeNext) anche se i file sono `.ts`.

**Serve Node 24, non 22, e non e una preferenza.** Il thread audio nasce da
`new Worker(PERCORSO_LAVORATORE)` con un percorso `.ts`, e il registrar di `tsx` **non entra nei
worker**: su Node 22 il worker muore subito con `Unknown file extension ".ts"`, `aspettaPronto()`
non torna mai, e `avviaMotore()` resta appeso per sempre -- l'intera suite di `index.test.ts` si
annulla senza un errore che spieghi perche. Node 24 i tipi li toglie da se e il worker parte.
Misurato su Linux con tutti e due (fatti verificati); su Windows non si era mai visto perche li
girava gia Node 24. Il pacchetto non ne soffre: dentro c'e `dist/**/*.js`, gia compilato.

**Nessun pacchetto contiene snapserver, e le due ragioni non sono la stessa.** Su Windows
`out/Regia-...-portabile.exe` contiene guscio, motore, interfaccia e ffmpeg ma non WSL2 — che
vuole Virtual Machine Platform, la virtualizzazione da BIOS e un riavvio (ADR 0003) — e non
contiene ancora la distro con snapserver dentro: `sede.ts` si aspetta che una distro già
installata venga scelta in Impostazioni. Su Linux quella frase non vale più: il sistema *è* già
quello che a snapserver serve, non c'è niente da abilitare né da riavviare. Resta che
snapserver va installato a parte, e con una trappola in più — **`apt install snapserver` su
Ubuntu 24.04 dà la 0.27.0, che Regia rifiuta di avviare** (ADR 0011); serve il `.deb` ufficiale
0.35. In tutti e due i casi il pacchetto parte e il server audio resta `spento` finché manca.
Le scelte di impacchettamento stanno commentate in `electron-builder.yml`.

**`ffmpeg:prendi` prende il binario della piattaforma che lo esegue**, e in `vendor/ffmpeg` ce
ne sta uno per volta: `extraResources` copia quella cartella intera, e `trovaFfmpeg()` cerca
`ffmpeg.exe` su Windows e `ffmpeg` altrove. **Il pacchetto Linux si costruisce su Linux**, e per
due ragioni indipendenti: electron-builder su Windows non ha gli attrezzi per farlo (`mksquashfs`
lo cerca solo per linux e darwin), e comunque `vendor/ffmpeg` conterrebbe il binario sbagliato.
I bersagli Linux sono **AppImage e `tar.gz`**: il `.deb` e escluso apposta, e in
`electron-builder.yml` c'e scritto cosa serve per riattivarlo.

**Regia si avvia anche senza Electron**: `npx tsx src/engine/avvia.ts --porta 7333 [--rete]`
serve l'interfaccia vera su HTTP, ed è il modo più rapido per pilotarla da script e guardarla
insieme. `--rete` la espone a tutta la LAN invece che a loopback (è il tablet della Fase 3).

## Il banco di prova (richiede una Sede)

Il collaudo gira **dentro la Sede**, la stessa del motore: `banco/sede-banco.ts` importa
`sedeDi()` da `src/engine/snapcast/sede.ts` invece di imitarlo, perché un banco che parlasse
alla Sede in un modo diverso da Regia misurerebbe un ambiente che al debutto non esiste. Su
Windows significa una distro WSL, su Linux questo PC.

```bash
npm run banco:prepara         # scarica snapserver+snapclient 0.35 nella Sede, versione fissata
                              # (su Linux chiede sudo: /opt non è dell'utente)
npm run banco:conf -- Ingresso Cantina Soffitta > /tmp/rg.conf
# poi si scrive la conf nella Sede e si lancia snapserver con setsid:
# i due comandi esatti li stampa `banco:prepara`, e sono diversi nelle due Sedi

npx tsx banco/altoparlanti-finti.ts 4   # Altoparlanti finti DENTRO la Sede
npx tsx banco/prova-flusso.ts           # gli stream passano a playing mentre si scrive
npm run banco:riconcilia                # riconciliatore contro il server vero
npm run banco:carico -- 40              # blocca il thread principale, verifica che l'audio regga
```

`REGIA_DISTRO` sceglie la distro del banco su Windows (`Ubuntu` di default, **non** il
`Regia-Snapserver` dell'ADR 0003 che il progetto propone). L'indirizzo delle sorgenti non si
passa più a mano: lo chiede alla Sede, e se non riesce a leggerlo **si ferma invece di ripiegare
su `127.0.0.1`** — contro un server morto la `connect()` riuscirebbe lo stesso attraverso un
inoltro di WSL, e la misura sarebbe una bugia. `HOST_FLUSSI` resta e vince su tutto, per puntare
il banco a un server su un'altra macchina.

`setsid` è obbligatorio: senza, snapserver riceve SIGHUP e muore appena esce il `wsl.exe` che l'ha
lanciato, e `nohup` da solo non basta. Resta anche su Linux, dove nessuno lo ucciderebbe, perché è
così che lo avvia il supervisore e il banco deve provare quel comando lì. Gli Altoparlanti finti
girano **dentro la Sede** perché il `snapclient.exe` per Windows non si sincronizza con un server
Linux — riporta uno scarto d'orologio di un epoch Unix e scarta ogni chunk. Su Linux quel
meccanismo non c'è, quindi il giro non servirebbe: **non è stato provato**, e il comando resta
identico perché passa comunque dalla Sede.

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
| snapserver | processo nella Sede | distribuisce l'audio ai telefoni |

La terza riga è l'unico confine che **cambia natura** fra le due piattaforme: su Windows sta
dentro una macchina virtuale con un'altra rete e un altro orologio, su Linux è un processo
accanto agli altri. È esattamente il motivo per cui ci passa un'interfaccia e non un `if`
(ADR 0011): il resto del motore non deve accorgersene.

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
  Suono, Effetto, Sottofondo, Flusso, Identifica, Ponte, Sede. `CONTEXT.md` è il glossario e va
  tenuto aggiornato; è deliberatamente privo di dettagli implementativi.
- **Gli schemi Zod in `src/engine/dominio/progetto.ts` sono la sola fonte di verità dei tipi**:
  i tipi TypeScript sono inferiti da lì, così non possono divergere dalla validazione.
- L'appartenenza a una Zona vive **sul dispositivo**, non come elenco nella Zona: l'invariante
  "appartiene a una sola Zona" è così vera per costruzione.

## Le tre fonti di documentazione

- **`docs/fatti-verificati.md`** — leggerlo **prima** di cambiare qualunque cosa tocchi Snapcast,
  la Sede, ffmpeg o le telecamere. Ogni riga è marcata `[sorgente]` (letto nel codice upstream),
  `[misurato]` (eseguito su questa macchina) o `[surrogato]` (misurato su un sostituto, da rifare).
  Quando il codice sembra strano, la ragione è quasi sempre lì.
- **`docs/adr/`** — quattordici decisioni, ciascuna con le alternative scartate e perché. Alcune sono
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
- **A una Sede WSL si parla per indirizzo IP, mai a `127.0.0.1`** (ADR 0010) — e a una Sede
  locale `127.0.0.1` è invece la risposta giusta. Non è una regola sul loopback, è una regola su
  WSL: gli inoltri che WSL crea su loopback **sopravvivono al processo che ascoltava**, quindi
  `connect()` riesce, i byte partono, non li legge nessuno. E `0.0.0.0` contiene `127.0.0.1`,
  quindi un ponte che inoltra lì parla con se stesso. Dove non c'è WSL non c'è nessun inoltro,
  snapserver ascolta già su `0.0.0.0`, e **il ponte non si apre affatto**: lo dice `serveIlPonte`,
  che è un membro della Sede e non una deduzione dall'indirizzo — dedurlo faceva scrivere nel
  Diario «i telefoni potrebbero non vedere il server audio» su un sistema che funziona (ADR 0011).
- **Snapserver sotto la 0.33 legge il nostro file e ne ignora metà, senza un errore.** In 0.33
  `[tcp]` è diventata `[tcp-control]`: una versione precedente parte, ascolta sulle porte sue, e
  il sintomo si scopre a metà serata. `avvia()` legge la versione e rifiuta invece di partire
  storto. Non è teorico: `apt install snapserver` su Ubuntu 24.04 dà la 0.27.0.
- **Su Linux Regia gira come l'utente che ha fatto login, non come root in una distro sua.**
  Quindi il `datadir` viene dalla Sede (`/var/lib/snapserver` è dell'utente di sistema
  `snapserver`, a 0750) e la cartella di lavoro sta in `XDG_RUNTIME_DIR`; e il `pkill -x
  snapserver` **non tocca** un `snapserver.service` che gira sotto un altro utente e tiene le
  porte. **Con quel servizio attivo il nostro snapserver parte lo stesso, sordo**: la 0.35 scrive
  `Address already in use` e continua con le sole sorgenti (misurato il 18 settembre 2026).
  Quindi la prova che il server sulla porta di controllo è il nostro non è `pgrep` ma **che abbia
  i Flussi del progetto** (`ServerEstraneo` in `collegaEVerifica`); quando non li ha, il
  supervisore spegne il suo e nomina il servizio per nome, chiedendolo a `systemctl is-active`.
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

## Agent skills

### Issue tracker

Le issue e i PRD vivono come markdown sotto `.scratch/<feature>/`, **fuori da git**: questo
repo non ha nessun remote, e `.scratch/` è ignorato. Vedi `docs/agents/issue-tracker.md`.

### Triage labels

I cinque ruoli di triage tengono i nomi inglesi di default (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`), scritti in una riga `Status:` in cima al
file della issue. Vedi `docs/agents/triage-labels.md`.

### Domain docs

Contesto singolo: `CONTEXT.md` alla radice e `docs/adr/`. Ma qui le fonti sono **tre** e
hanno una precedenza — `docs/agents/domain.md` la riassume per chi arriva da fuori e rimanda
a `## Le tre fonti di documentazione` qui sopra, che resta l'originale.

## Import da altri agenti

C'è una configurazione Codex in `~/.codex/config.toml`. Se vuoi importarne gli elementi
(server MCP, comandi, subagent, skill, istruzioni), rispondi `/import` per vedere cosa è
importabile, poi `/import --yes=<digest>` con il digest indicato dalla scansione.

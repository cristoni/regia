# Fatti verificati

Cose lette nel sorgente o misurate, con la fonte accanto. Non sono opinioni di progetto: sono
vincoli. Quando il codice sembra strano, la ragione e quasi sempre qui.

Ogni riga e marcata: **[sorgente]** letto nel codice upstream · **[misurato]** eseguito su questa
macchina · **[surrogato]** misurato su qualcosa che somiglia al vero, e va rifatto sul vero.

---

## Snapserver 0.35: configurazione

- **[sorgente]** L'host di una sorgente `tcp://` **deve essere un IP numerico**. Finisce in
  `boost::asio::ip::make_address()`, che lancia su `localhost`. Coerente con il §2.2 del documento
  di progetto, ma per una ragione diversa da quella che immaginava.
  `server/streamreader/tcp_stream.cpp:58`
- **[sorgente]** `mode=server` e il default, e la porta di default e 4953.
  `tcp_stream.cpp:41-57`
- **[sorgente]** Parametri che una sorgente `tcp://` legge davvero, e nessun altro: `name`,
  `codec`, `sampleformat`, `chunk_ms`, `controlscript`, `controlscriptparams`,
  `silence_threshold_percent`, `idle_threshold`, `buffer_ms`, `mode`, `port`.
  `pcm_stream.cpp:56-92` + `asio_stream.hpp:121-131` + `tcp_stream.cpp:47-57`
- **[sorgente]** **`buffer` e solo globale.** Non esiste un override per sorgente: sta in
  `[stream]` e vale per tutte. Stessa cosa per `send_to_muted`. Invece `sampleformat`, `codec` e
  `chunk_ms` sono default globali *iniettati* nella query di ogni sorgente che non li specifica.
  `stream_manager.cpp:71-81`
- **[sorgente]** Default globali di `[stream]` nella 0.35: `codec=flac`, `sampleformat=48000:16:2`,
  `chunk_ms=20`, `buffer=1000`. **Tutti e tre diversi da quello che ci serve**: vanno scritti
  esplicitamente, non ereditati. `server_settings.hpp:214-235`
- **[sorgente]** Sezioni della 0.35: `[server]`, `[ssl]`, `[authorization]`, `[http]`,
  `[tcp-control]`, `[tcp-streaming]`, `[stream]`, `[streaming_client]`, `[logging]`. Le vecchie
  `[tcp]` e `stream.port` sono accettate come deprecate, con warning. `snapserver.cpp:118-145`
- **[sorgente]** `snapserver` non ha ricaricamento a caldo: SIGHUP, SIGINT e SIGTERM condividono
  lo stesso handler di spegnimento. Conferma [ADR 0005](adr/0005-il-file-di-progetto-e-la-verita-snapserver-e-una-proiezione.md):
  cambiare le Zone significa riavviare, non ricaricare.

### Due trappole all'avvio

- **[sorgente]** `Server::start()` avvia nell'ordine: gestore degli stream, server di controllo
  (1780 e 1705), server di streaming (1704). Gli acceptor delle sorgenti `tcp://` sono quindi
  **gia aperti quando la 1780 risponde**: un controllo di salute sulla 1780 e un cancello
  conservativo e sicuro prima di far connettere il mixer alle 4953+n.
- **[sorgente]** `start()` rilancia l'eccezione: **una sola porta occupata fra le tredici
  impedisce l'avvio dell'intero server**, e l'errore che si vede e un opaco `Invalid argument`.
  Il generatore di configurazione deve verificare le porte prima, e dire quale.

---

## Snapserver 0.35: la sorgente TCP sotto il mixer

- **[sorgente]** In `mode=server` snapserver accetta **una sola connessione alla volta**. Non
  viene postato un secondo `async_accept` finche la connessione corrente non va in errore. Una
  seconda connessione resta nel backlog del kernel — e **`connect()` che riesce non e prova che
  snapserver stia leggendo**. Questa e la trappola della riconnessione: mezzo aperta, il mixer
  crede caduta la socket, snapserver la tiene ancora, e i byte della socket successiva restano in
  coda per essere riprodotti minuti dopo.
  → **Invariante: una sola socket per porta sorgente, sempre.** Chiudere esplicitamente, e non
  fidarsi di `connect()`. L'unica conferma applicativa che snapserver stia leggendo e lo stato
  dello stream che passa `idle → playing`, visto via JSON-RPC.
- **[sorgente]** La lettura e una `async_read` di **esattamente** `chunk_ms` di byte (3528 a
  44100:16:2 con 20 ms). Scritture non allineate a 3528 sono innocue. Scritture non allineate a
  **4 byte** (un frame stereo a 16 bit) invertono L e R **per sempre**, e snapserver non ha modo
  di riallinearsi. Va messo come assertion, non come commento.
- **[sorgente]** `idle_threshold` vale 100 ms di default e il controllo di stato scatta a
  `idle_threshold + chunk_ms` = 120 ms. E la causa del lampeggio `idle ⇄ playing`, cioe del
  guasto del §2.2. **Portarlo a 2000 lo cancella, e non costa niente.**
- **[misurato]** Lo snapclient fa una risincronizzazione dura solo sopra `abs(age) > 500 ms`.
  L'obiettivo quindi **non e zero risincronizzazioni**, e nessuna abbastanza grande da innescare
  quella dura. I due sintomi sono separati: `idle_threshold` cura il lampeggio di stato, la
  scrittura in anticipo cura il salto di timeline.
- **[surrogato]** Con circa 190 KB di coda disponibile attraverso il ponte WSL (~1,07 s di audio),
  il margine e appena sopra un anticipo da 1 s. Con 13 socket sarebbero ~2,3 MB in volo.
- **[misurato]** Scrivere "finche non arriva contropressione" fa crescere la finestra TCP fino a
  ~600 KB, cioe ~3,4 s di audio in volo, **senza un errore da nessuna parte**. L'anticipo va
  imposto come tetto duro sui byte in volo contro un orologio monotono, mai ascoltando `drain`.
- **Conseguenza sulla latenza, che nessuno aveva collegato:** l'anticipo **si somma** al `buffer`.
  Con `buffer=2000` e anticipo 200 ms la latenza dal pulsante al suono e 2,2 s; con anticipo 1 s
  diventa 3,2 s. L'anticipo e un parametro di latenza, non solo di robustezza.

---

## Snapserver 0.35: JSON-RPC

- **[sorgente]** Il percorso WebSocket di controllo e **esattamente `/jsonrpc`** sulla porta 1780.
  Confronto esatto di stringa: niente query string, niente slash finale. L'altro percorso che
  accetta l'upgrade e `/stream`, che pero e il canale audio binario.
- **[sorgente]** `Client.SetLatency` e limitato a `[-10000, buffer del suo stream]`. Con
  `buffer=2000` l'intervallo utile e da -10000 a +2000, non simmetrico.
### Verificato contro una 0.35 vera, l'8 settembre 2026

Il dubbio sulla 0.27 e chiuso: **le forme dei metodi che ci servono sono identiche sulla 0.35**.
Il server riporta `controlProtocolVersion: 1`, `protocolVersion: 1`, `version: "0.35.0"`.

- **[misurato]** **Ogni client che si connette riceve un gruppo tutto suo**, con un id UUID
  generato dal server, e quel gruppo punta al **primo stream della configurazione** -- non a uno
  stream "non assegnati". Tre client connessi hanno prodotto tre gruppi, tutti su `Ingresso`.
  Il riconciliatore deve quindi *consolidare*, non *assegnare*: il lavoro c'e sempre.
- **[misurato]** `Group.SetClients` risponde con lo stato completo del server (`{server: ...}`),
  non con una conferma. Il gruppo rimasto vuoto **sparisce**.
- **[misurato]** Togliere un client da un gruppo gli crea **un gruppo nuovo con un UUID nuovo**,
  che eredita lo stream del gruppo da cui e uscito. Non si puo scegliere l'id di un gruppo: si
  puo solo scoprirlo dopo.
- **[misurato]** `Group.SetStream` risponde `{stream_id}`. Con uno stream inesistente risponde
  errore `-32603`, `data: "Stream not found"`.
- **[misurato]** `Client.SetName` risponde `{name}`, `Client.SetVolume` risponde
  `{volume: {muted, percent}}` con `percent` da 0 a 100 (non 0-1).
- **[misurato]** **`Client.SetLatency` tronca al `buffer`, in silenzio.** Chiesti 5000 ha
  risposto 2000; chiesti 9999 ha risposto 2000. Il valore ottenuto va riletto dalla risposta,
  mai assunto.
- **[misurato]** Un client che si scollega **resta nel suo gruppo** con `connected: false` e
  **conserva la sua configurazione** (nome, volume, latenza). E per questo che serve
  `Server.DeleteClient` per il comando "dimentica": sparire dalla rete non basta.
- **[misurato]** `Client.OnDisconnect` porta `{client: {...}}`; `Server.OnUpdate` porta
  `{server: {...}}` completo. Gli stream nascono con `status: "idle"`.
- **[misurato]** **Chi provoca un cambiamento non riceve la notifica di quel cambiamento**: la
  risposta va a chi ha chiesto, la notifica a tutti gli altri. Un riconciliatore che aspettasse
  di veder tornare indietro la propria modifica resterebbe fermo per sempre: si rilegge lo stato,
  non si aspetta l'eco.
- **[misurato]** Su Windows il MAC riportato e `00:00:00:00:00:00`: **`--hostID` e obbligatorio**
  per avere client distinti. E l'id finale non e quello che passi: con `-i <n>` diverso da 1, il
  server ci appende `#<n>`. `--hostID finto-2 -i 2` diventa il client `finto-2#2`.

---

## La distro WSL, misurata

- **[misurato]** Il `.deb` ufficiale **bookworm** di snapserver 0.35 **gira su Ubuntu 24.04 senza
  modifiche**. Ubuntu 24.04 ha rinominato `libflac12` in `libflac12t64` (e cosi `libasound2` e
  `libssl3`) per la transizione `time_t`, quindi `dpkg -i` fallirebbe sulle dipendenze -- ma sono
  solo metadati: `ldd` sul binario estratto con `dpkg-deb -x` non riporta **nessuna** libreria
  mancante, e `snapserver -v` risponde `v0.35.0`. Conferma che snapserver 0.35 **non dipende da
  libboost**.
  → Regia puo distribuire il `.deb` estratto invece che installato, il che elimina del tutto il
  problema della distro ospite.
- **[misurato]** **Snapserver muore quando esce il `wsl.exe` che l'ha lanciato**, con
  `Received signal 1: Hangup`. `nohup` da solo **non** basta: WSL termina il gruppo di processi
  della sessione. `setsid` lo tiene vivo.
  → Due strade, ed e una scelta: tenere vivo il `wsl.exe` figlio (si guadagnano log e watchdog,
  si perde la sopravvivenza a un crash di Regia), oppure staccarlo con `setsid` e ricollegarsi.
- **[misurato]** `hostname -I` dentro la distro restituisce come primo indirizzo l'IP Wi-Fi di
  Windows (`192.168.1.4`): la conferma diretta che su **questa** macchina `mirrored` e attivo, e
  quindi che le misure di rete non valgono per un Windows di fabbrica. Vedi la misura 1 in fondo.
- **[misurato]** **Il 9 settembre 2026 `mirrored` ha smesso di funzionare su questa macchina**,
  dopo gli aggiornamenti Windows dell'8 settembre (KB5126052 piu due di sicurezza; build passata a
  26200.9445). `wsl` fallisce con `CreateInstance/CreateVm/ConfigureNetworking/0x8007054f` e
  **ricade su `None`**: la distro resta **senza rete**, niente `eth0`, nessuna rotta predefinita.
  Non lo risolvono ne un riavvio di Windows ne `wsl --update` (provata la 2.7.13, kernel 6.18).
  Sospetto principale, **non verificato**: **Npcap** (`INSECURE_NPCAP`) legato alla scheda Wi-Fi
  accanto a `ms_l1vhlwf`, il filtro NDIS della rete annidata su cui `mirrored` si appoggia;
  rimuoverlo richiede privilegi di amministratore.
  → La riga qui sopra **non e riproducibile oggi**, e con essa tutte le misure di rete prese
  quando `mirrored` era attivo.
- **[misurato]** In `networkingMode=NAT` la distro prende una `eth0` NAT (`172.30.235.47/20`),
  raggiunge internet e **raggiunge la LAN in uscita**: la telecamera a `192.168.1.7:4444` risponde
  `200` da dentro la distro. Ma WSL inoltra le porte in ascolto **solo su `127.0.0.1`** —
  `netstat` mostra `127.0.0.1:1704 LISTENING` e `192.168.1.4:1704` irraggiungibile. Windows
  raggiunge snapserver, il telefono no.
  → Serve un inoltro esplicito. `netsh interface portproxy` vuole l'amministratore; un processo in
  spazio utente che ascolti su `0.0.0.0` e rigiri a `127.0.0.1` **non lo vuole**, ed e bastato a
  far collegare un telefono vero e a fargli suonare il Flusso. E la misura 1 in fondo, nella sua
  sostanza.
- **[misurato]** Con un inoltro di quel tipo snapserver vede il client all'indirizzo del **ponte**,
  non del telefono: il Pixel 10, che sta a `192.168.1.7`, compare come `127.0.0.1`. Il
  riconciliatore non ne soffre (abbina per client id), ma il campo `indirizzo` di
  `AltoparlanteVivo` sarebbe inutilizzabile finche si passa di li.

## android-ip-camera (commit d15dbb7, v0.12.0)

- **[sorgente]** `/video/h264` **non accetta query string**: con una qualsiasi, il server risponde
  `200 OK` in testo semplice invece dello stream. Vale per tutti gli endpoint di streaming.
- **[sorgente]** L'intervallo dei fotogrammi chiave e **fissato a 1 secondo e non configurabile**
  (`H264HardwareEncoder.kt:63`). Un client che si collega non riceve **niente** finche non arriva
  il primo IDR: fino a un secondo di nero. Ogni IDR e preceduto da SPS e PPS, quindi e
  autonomamente decodificabile — il che rende sensato tenere in cache l'ultimo IDR per far partire
  subito una seconda interfaccia.
- **[sorgente]** Lo streaming va **acceso** con `/control/start`, e `streaming_enabled` **e
  persistente fra i riavvii**. Come tutte le altre impostazioni: risoluzione, zoom, rotazione,
  torcia restano come le ha lasciate l'ultima volta. → Regia deve applicare un preset completo
  all'avvio, senza fidarsi dei default.
- **[sorgente]** Il MJPEG emesso **non ha il CRLF dopo i byte JPEG e non ha l'epilogo finale**: un
  parser che cerca il boundary si incastra. Va usato `Content-Length`.
- **[sorgente]** L'header WAV di `/audio` e **malformato**: la dimensione RIFF e `0x80000023`
  (overflow) mentre quella del blocco dati e `0x7FFFFFFF`. ffmpeg e VLC lo tollerano, altri no. Il
  contenuto e PCM 16 bit little endian, mono, 44100 Hz: saltare 44 byte e leggere il resto.
- **[sorgente]** Il limite di client concorrenti dipende da **se l'autenticazione e attiva**, non
  dall'esito del login. Disattivarla per semplicita **dimezza** i limiti e accorcia la scadenza
  delle connessioni MJPEG da 24 ore a 30 minuti.

### Misurato su un Pixel 10 vero, il 9 settembre 2026

- **[misurato]** Il telefono **non emette B-frame**: `has_b_frames=0`, e su ~11 secondi di
  `/video/h264` a 720x480 si contano **11 fotogrammi I e 209 P**, in sequenza `I P P P ...`.
  → La registrazione in MP4 non avra il problema di PTS uguale a DTS con l'ordine di presentazione
  sbagliato. E la misura 4 in fondo, chiusa.
- **[misurato]** L'intervallo fra IDR e **confermato per misura**, non piu solo letto nel sorgente:
  una `I` ogni **20 fotogrammi** con `fps=20`, cioe esattamente un secondo.
- **[misurato]** `/info.json` espone i campi che `TelecameraViva` dichiara e che finora nessuno
  sapeva da dove prendere: `batteryPercent`, `wifiStrength`, e dentro `settings` anche `torch`,
  `deviceHasFlash`, `streamRes`, `fps`, `cameraId`. → E li che Regia trova batteria e segnale, e
  `torch` e la leva dell'Identifica sulle Telecamere.
- **[misurato]** `snapshotRes` impostato su `"stream"` **non viene rispettato da
  `/video/snapshot`**: con `streamRes` a 720x480 lo scatto e uscito **4000x3000, 1,9 MB**. Chi
  usasse gli snapshot per le anteprime muoverebbe due megabyte a fotogramma invece di
  un'immagine da 720x480.
- **[misurato]** Un Pixel 10 espone **cinque obiettivi** (`0:2`, `0:3`, `0:4` dietro, `1:5`, `1:6`
  davanti), tutti fino a 3840x2160: l'identificativo di camera non e un indice ma una coppia.

---

## ffmpeg su questa macchina

- **[misurato]** ⚠️ L'`ffmpeg` in PATH **non e il binario vero**: e uno shim Chocolatey da 26.112
  byte che lancia il vero ffmpeg come processo figlio. **`child.kill()` uccide lo shim e lascia il
  vero ffmpeg orfano.** Regia deve usare il binario in bundle, non quello del PATH.
- **[misurato]** `-r` sull'input **forza il CFR e sbaglia la durata** se la sorgente devia dal
  nominale: 20 secondi reali sono diventati un file da 8 secondi. Non usarlo per registrare.
- **Due modelli del tempo, scelti apposta**: l'anteprima usa un contatore a fps nominale (i
  timestamp di WebCodecs sono inerti e non governano la resa), la registrazione lascia che sia
  ffmpeg a datare. Sono componenti diversi, va bene che divergano — purche sia deliberato.

---

## WebCodecs

- **[sorgente]** Per Annex-B il campo `description` di `VideoDecoderConfig` **va omesso**. La sua
  presenza non e opzionale: e il selettore che commuta il decoder in modalita avcC.

---

## Il banco di prova

- **[misurato]** ⚠️ **Il `snapclient.exe` per Windows non si sincronizza con un snapserver
  Linux.** Riporta `diff to server [ms]: -1.78885e+12` -- meno cinquantasei anni, l'ordine di
  grandezza esatto dell'epoch Unix -- e da li scarta ogni chunk, ripetendo "No chunks available"
  una volta al secondo. Lo **stesso** client compilato per Linux, contro lo **stesso** server,
  riporta `diff to server: 0.008 ms` e non perde nulla. Le due basi temporali non sono la stessa.
  → Gli Altoparlanti finti girano **dentro la distro**. Non tocca il prodotto (Snapdroid usa un
  client Android), ma un PC Windows non puo fare da Altoparlante aggiuntivo.
- **[misurato]** Quattro client Linux nella distro si sincronizzano a **7-14 microsecondi**.
- **[misurato]** `--player file:filename=/dev/null` consuma i chunk al ritmo giusto senza toccare
  una scheda audio: e il player nullo che serve a un soak lungo.
- **[misurato]** `pkill -f "<percorso del binario>"` **uccide la shell che lo esegue**, perche il
  percorso compare anche nella riga di comando di quella shell. Tutto cio che viene dopo non
  succede, in silenzio. Si usa `pkill -x snapclient`, sul nome esatto del processo.

## Il percorso audio, misurato da capo a fondo

Quattro Zone, quattro sorgenti TCP, quattro Altoparlanti finti, `buffer = 2000`:

- **[misurato]** Scrivendo, tutti gli stream passano da `idle` a `playing` entro tre secondi, e
  tornano a `idle` due secondi dopo che si smette -- esattamente `idle_threshold`. E l'unica
  conferma applicativa che snapserver stia davvero leggendo.
- **[misurato]** In quattordici secondi di scrittura continua: 711 blocchi per sorgente, 2.450 KB,
  scarto sempre positivo (~200 ms avanti all'orologio), **zero buchi e zero cadute**.
- **[misurato]** Sweep dell'anticipo a 50 / 100 / 200 / 400 / 1000 ms, venti secondi ciascuno:
  **nessuna risincronizzazione e nessun chunk perso, a nessun valore**. I client non si sono mai
  accorti di niente.
- **[misurato]** Restavano pero i riallineamenti **nostri**: lo scrittore ogni tanto restava
  indietro di oltre mezzo secondo e rinunciava a un pezzo di Flusso. Con quattro scrittori, otto
  client e un server sulla stessa macchina, sul thread principale di Node.
  → **Risolto spostando mixer e scrittori in un `worker_thread`** (ADR 0004). Prova: bloccando il
  thread principale **per 28,4 secondi su 40**, con blocchi singoli fino a 119 ms, i quattro
  Flussi hanno perso **0 ms** e sono rimasti tutti ~210 ms avanti all'orologio, senza una caduta.
  Si riproduce con `npx tsx banco/carico-dal-vero.ts 40`.
- **[misurato]** `worker.unref()` sul thread audio **rompe l'avvio**: un worker scollegato dal
  ciclo di eventi non lo tiene vivo, quindi mentre il thread principale aspetta la prima risposta
  del thread audio Node considera il processo senza lavoro e chiude, lasciando l'attesa appesa per
  sempre (`Detected unsettled top-level await`). Il thread audio deve tenere viva Regia: finche il
  Flusso scorre, l'app c'e.
- **[misurato]** Su Windows la risoluzione dei timer e 15,6 ms: `setTimeout(20)` dorme ~31 ms.
  Svegliandosi a ogni blocco si perdono ~11 ms per giro, e in dodici secondi si accumulano 6,5
  secondi di riallineamento con scarto **negativo**. Ci si sveglia ogni mezzo anticipo e si
  scrivono piu blocchi per volta.

---

## Le misure che restano al telefono vero

Aggiornato il **9 settembre 2026**, dopo la prima serata con un Pixel 10 vero collegato: un
Altoparlante Snapcast ha suonato il Flusso prodotto da Regia, e lo stesso telefono ha fatto da
Telecamera. Due voci sono chiuse, una ha risposta nella sostanza.

Il titolo diceva "le cinque misure" ma l'elenco ne ha sempre avute quattro: la quinta o non e mai
stata scritta o si e persa. Se te ne viene in mente una, aggiungila.

In ordine di quanto bloccano:

1. ~~**Raggiungibilita LAN → WSL su una macchina in configurazione di fabbrica.**~~ —
   **RISOLTA il 9 settembre 2026.** Su questa macchina `mirrored` si e rotto e la
   configurazione e ora **NAT**, cioe la stessa di un Windows di fabbrica: WSL espone le porte
   **solo su `127.0.0.1`** e il telefono non le vede. Con un inoltro in spazio utente — che
   **non** richiede l'amministratore, a differenza di `netsh portproxy` — un telefono vero si e
   collegato e ha suonato. Vedi la sezione sulla distro WSL.
   → La scelta e chiusa da [ADR 0010](adr/0010-il-ponte-di-rete-fa-parte-di-regia.md): **il ponte
   fa parte di Regia**, si accende da se e non si pretende `mirrored`. Il primo ponte inoltrava a
   `127.0.0.1`, e proprio quell'ADR lo vieta: la destinazione e l'indirizzo della distro.
2. **Sweep dell'anticipo** a 50 / 100 / 200 / 400 / 1000 ms, dieci minuti ciascuno, da Node su
   Windows attraverso il ponte, con tutte e tredici le socket, registrando la **distribuzione**
   delle magnitudini di risincronizzazione e non il loro numero.
3. ~~**Quale porta di controllo usa Snapdroid** (1705 o 1780)~~ — **RISOLTA il 9 settembre 2026.**
   Snapdroid su un Pixel 10 apre **prima la 1705** (controllo) e cinque secondi dopo la 1704
   (flusso). Quindi **`[tcp-control]` va acceso**, come gia fa il generatore di configurazione.
   Cautela: erano inoltrate solo la 1704 e la 1705, non la 1780, quindi non si esclude che con la
   1780 disponibile Snapdroid preferisca quella — si esclude solo che gli serva.
4. ~~**Se il telefono emette B-frame.**~~ — **RISOLTA il 9 settembre 2026: non li emette.**
   `has_b_frames=0`, 11 fotogrammi I e 209 P su ~11 secondi di `/video/h264`. La registrazione in
   MP4 non avra il problema di PTS uguale a DTS.

---

## Il percorso verso la distro, misurato il 9 settembre 2026

Tutto questo blocco viene dal primo avvio di Regia intera — motore, interfaccia, snapserver vero,
un Pixel 10 come Telecamera e quattro Altoparlanti finti — su questa macchina in `networkingMode=NAT`.

- **[misurato]** ⚠️ **Gli inoltri di WSL su `127.0.0.1` sopravvivono al processo che ascoltava.**
  Dopo che snapserver muore, `connect()` su `127.0.0.1:4953` continua a riuscire, i byte partono e
  non li legge nessuno: `ss` dentro la distro non mostra nemmeno la connessione. È
  indistinguibile da un server che accetta e non consuma, e il thread audio scriveva Flusso
  perfetto dentro un fantasma.
  → **Le socket delle sorgenti si aprono verso l'IP della distro** (`hostname -I`), non verso
  loopback. Verificato: con l'indirizzo della distro, `ss` mostra una connessione per porta da
  `172.30.224.1` (Windows) a `172.30.235.47` (distro), nessun tramite. Vedi ADR 0010.
- **[misurato]** ⚠️ **`0.0.0.0` contiene `127.0.0.1`**: un ponte che ascolta su `0.0.0.0:1705` e
  inoltra a `127.0.0.1:1705` parla con se stesso. Il giro a vuoto accetta connessioni all'istante
  e non risponde mai. Il supervisore lo adottava come se fosse snapserver e non avviava mai il
  server vero.
  → La prova che snapserver c'è è **una risposta a `Server.GetStatus`**, non una `connect()`.
- **[misurato]** ⚠️ **In bash `&` ha precedenza più bassa di `&&`.** Scritto
  `mkdir -p /tmp/regia && setsid snapserver ... &`, l'intera catena finisce in background,
  `mkdir` compreso, e la shell esce prima che succeda qualcosa: **nessun errore, nessun log,
  nessun server**, ed esito zero. Il `mkdir` va su una riga sua, e dopo il lancio si verifica con
  `pgrep -x snapserver` invece di fidarsi di un `echo`.
- **[misurato]** **`idle` non significa "non arrivano byte": significa "arriva silenzio".**
  Con sette sorgenti scritte in continuo ma senza Sottofondo, tutti gli stream restano `idle`, e
  `ss` conferma che snapserver **legge** (la coda di ricezione resta ferma a poche decine di KB
  invece di riempirsi). Basta far partire un Sottofondo in una Zona perché quello stream, e solo
  quello, passi a `playing`. È esattamente ciò che `idle_threshold` misura.
  → Il criterio applicativo «tutti gli stream passano a `playing` entro tre secondi» vale
  **mentre si suona qualcosa**, non a casa vuota.
- **[misurato]** **Fermare uno scrittore mentre la sua `connect()` è in volo lasciava la socket
  aperta e abbandonata.** `ferma()` staccava la destinazione, ma il ciclo finiva comunque di
  collegarsi e ne assegnava una nuova. Sintomo osservato con `ss`: connessioni che Regia credeva
  chiuse con `Send-Q 2634240` — 2,6 MB di audio fermo — e la coda di accettazione di snapserver
  che cresceva a ogni riconnessione.
- **[misurato]** **Una socket che non si scarica blocca l'intero thread audio.** Lo scrittore
  restava fermo dentro `attendiScarico()`, `ferma()` lo aspettava, `configura` aspettava `ferma()`,
  e da lì in poi nessun comando audio veniva più eseguito. Il sintomo era un Suono importato che
  non finiva mai di importarsi — a chilometri dalla causa. Ora l'attesa di scarico ha un tetto in
  tempo **vero** (non nella timeline audio, o la cadenza si troverebbe un secondo da recuperare),
  e chi scade molla la connessione e si ricollega.
- **[misurato]** Un Pixel 10 vero come Telecamera, `/video/h264` sdoppiato dal motore e
  decodificato con WebCodecs nella pagina: **20 fps stabili**, batteria e segnale letti da
  `/info.json`, nessun artefatto. La stringa del codec va ricavata dall'SPS (`avc1.PPCCLL`): i tre
  byte dopo l'intestazione della NAL di tipo 7.
- **[misurato]** Lo spezzatore Annex-B: cercare il codice di avvio successivo **a partire dal
  byte 1** è sbagliato, perché un codice lungo `00 00 00 01` contiene un codice corto `00 00 01`
  dal suo secondo byte. Si cerca da 3. Sbagliato, taglia ogni NAL dopo un byte solo e il decoder
  non parte mai.

## Identifica, registrazione e DPAPI, misurati il 9 settembre 2026

Le tre parti che fino a qui erano scritte e mai eseguite. Il Pixel non era più in rete: dove
manca il telefono vero la riga lo dice, ed è marcata `[surrogato]`.

- **[misurato]** **Identifica funziona come dice l'ADR 0006**, contro un snapserver 0.35 vero con
  quattro snapclient collegati. Con l'Altoparlante dentro una Zona: lo stream della Zona passa a
  `playing` mentre il segnale suona, **l'altro client del gruppo risulta `muted: true` durante** e
  torna `muted: false` dopo, e **il client identificato non viene mai mutato** — nessuno cambia
  gruppo, quindi nessuno si risincronizza.
- **[misurato]** **Vale identico per un Altoparlante non assegnato**: lo stream `Non assegnati`
  passa a `playing` e l'altro non assegnato viene mutato e ripristinato. È la prova che la chiave
  interna `@non-assegnati` arriva davvero fino al mixer giusto: senza il tredicesimo Flusso non
  uscirebbe niente, ed è il caso più frequente di tutto il Setup.
- **[misurato]** **Un riavvio del server che fallisce lasciava Regia in uno stato terminale.**
  Osservato per caso con la distro sbagliata nelle impostazioni: `riconfigura()` fermava
  snapserver, `avvia()` falliva, lo stato diventava `non installato` e **nessuno riprovava più** —
  perché a chiedere quel riavvio non era stato un Operatore ma un cambio di Zone, e l'eccezione non
  aveva nessuno a cui arrivare. Il Diario si riempiva di «la socket non si scarica», che è il
  sintomo e non la causa. Ora la riconfigurazione non lascia mai uscire l'eccezione: scrive una
  riga grave e riprova ogni otto secondi.
- **[surrogato]** **La registrazione conserva la durata reale.** Venti secondi di H.264 Annex-B
  con i parametri misurati sul Pixel (720x480, 20 fps, un IDR al secondo, niente B-frame) versati
  nel Registratore **al ritmo dell'orologio**: il file dura quanto la versata, non quanto
  direbbero i fotogrammi. È la conferma che `-use_wallclock_as_timestamps 1` con
  `-fps_mode passthrough` cura il difetto di `-r` (20 secondi veri → file da 8). Da rifare col
  telefono vero: la sorgente qui è un file, e la rete non c'è di mezzo.
- **[surrogato]** **Il §3.7 regge alla caduta**: staccando il flusso a metà, il primo file si
  chiude bene e resta apribile, e la registrazione riprende **su un file nuovo** appena i byte
  tornano. Due file, entrambi leggibili da `ffprobe`, durata totale entro il 5% dell'orologio
  meno il buco.
- **[misurato]** **ffmpeg si lamenta sempre quando entra in un flusso H.264 già cominciato**:
  `non-existing PPS 0 referenced`, `decode_slice_header error`, `no frame!` finché non arriva il
  primo fotogramma chiave. Misurate 68 righe in una ripresa sola. Non è un guasto e non c'è niente
  da fare, ma nel Diario — che il §3.10 vuole leggibile dall'Operatore — erano 68 allarmi in mezzo
  a quello vero. Si riassumono in una riga sola. Restano invece visibili `Timestamps are unset` e
  `Non-monotonic DTS`, che sono poche e dicono qualcosa sul muxing.
- **[misurato]** Lo stderr di ffmpeg **arriva a pezzi che non coincidono con le righe**: senza
  ricomporlo sui ritorni a capo, nel Diario finiscono mezze parole (`Last message repeated 1 tim`
  su una riga, `es` sulla successiva).
- **[misurato]** **DPAPI funziona senza moduli nativi**, via PowerShell e
  `System.Security.Cryptography.ProtectedData`: una password di 34 caratteri con accenti diventa
  352 caratteri di base64 e torna identica. La stringa vuota resta vuota in tutte e due le
  direzioni. Serve `powershell` (Windows PowerShell), **non `pwsh`**: `ProtectedData` non c'è in
  .NET Core.
- **[misurato]** Il banco di carico, rifatto dopo i tre cambiamenti allo `Scrittore`: 40 secondi
  con il thread principale bloccato per 28,1 s (blocco più lungo 119 ms), **quattro Flussi attivi,
  0 ms di buchi, 0 cadute**, scarto stabile a ~200 ms. Il tetto all'attesa di scarico non produce
  riconnessioni spurie.
- **[misurato]** L'indirizzo con cui un telefono compare in `Server.GetStatus` dipende da com'è
  fatto il ponte, e la riga più su (riga 163, «compare come `127.0.0.1`») valeva per il ponte
  vecchio, quello che inoltrava verso loopback. Col ponte che punta alla distro, il Pixel 10
  compare come **`172.30.224.1`**: l'indirizzo del PC sulla rete della distro. Resta vero il
  punto: non è l'indirizzo del telefono, e il campo va mostrato come "via ponte".
- **[misurato]** La distro predefinita di un progetto nuovo è `Regia-Snapserver` (ADR 0003) e su
  questa macchina **non esiste**: snapserver sta in `Ubuntu`, installato a mano dal banco. Un
  progetto appena creato quindi non riesce ad avviare il server finché in Impostazioni non si
  cambia la distro — e il messaggio d'errore lo dice già, nominando quelle disponibili. Non è un
  difetto del codice, ma è la prima cosa in cui inciampa chiunque parta da un progetto vuoto qui.

## L'audio nelle registrazioni, misurato il 9 settembre 2026

Il §7 mette «Registrazione con audio» in Fase 2 e la Fase 1 «solo video»; è stata implementata in
anticipo su richiesta. Il telefono non era in rete durante la prova: le righe che dipendono dal
telefono sono `[surrogato]` e vanno rifatte con lui.

- **[misurato]** **ffmpeg finisce quando finiscono *tutti* i suoi ingressi, non solo lo stdin.**
  Con il secondo ingresso ancora aperto, `stdin.end()` non lo fa uscire: si arriva al timeout di
  cinque secondi, lo si ammazza, e il file resta **senza `moov`** — cioè illeggibile. È lo stesso
  difetto contro cui esiste la regola «si chiude con `stdin.end()`, mai con `kill()`», visto da
  un'altra porta. → Il secondo ingresso si chiude **prima** di aspettare l'uscita di ffmpeg.
- **[misurato]** Con la pompa che scrive a ritmo d'orologio e parte al primo byte di video, le due
  tracce escono lunghe **24,81 s (video) e 24,88 s (audio): 77 ms di scarto**, dentro «qualche
  decimo di secondo» che il §3.7 concede. Far partire l'audio all'avvio di ffmpeg invece che al
  primo fotogramma lo portava a **5 s** di scarto: ffmpeg normalizza ogni ingresso a partire dal
  proprio primo pacchetto, e il video non comincia finché non arriva un fotogramma chiave.
- **[misurato]** Staccando la sorgente audio a metà ripresa, la traccia prosegue e il video non si
  ferma: misurato `mean_volume -16,5 dB` nei primi dieci secondi (il tono) e **-91,0 dB** dopo lo
  stacco, cioè silenzio digitale esatto. È la prova che accendere l'audio non può far perdere il
  video: l'ingresso non tace mai, quindi ffmpeg non si blocca mai ad aspettarlo.
- **[misurato]** Riempire di silenzio **ogni** volta che la coda è vuota è sbagliato: la rete
  consegna a raffiche, e ogni raffica produrrebbe un clic. Si aspetta un quarto di secondo prima di
  inventare silenzio, e si mette silenzio comunque se il ritardo accumulato supera un secondo —
  altrimenti un telefono con l'orologio lento porterebbe l'audio sempre più indietro rispetto al
  video.
- **[misurato]** Il canale verso il secondo ingresso è una **socket TCP su loopback**, non una
  `pipe:`. Su Windows i descrittori oltre stdin/stdout/stderr non arrivano al processo figlio in
  modo affidabile; `-i tcp://127.0.0.1:porta` fa collegare ffmpeg come un client qualsiasi, e la
  porta resta la stessa fra un ffmpeg e il successivo dopo una caduta.
- **[surrogato]** `/audio` non è mai stato letto da un telefono vero in questa prova: la porta 4444
  del Pixel non rispondeva più (il telefono rispondeva al ping, l'app non serviva). Restano da
  confermare sul campo: che i 44 byte di intestazione WAV siano davvero 44 su questo firmware, che
  il flusso sia mono a 44100 Hz come dice il sorgente upstream, e che aprire `/audio` mentre
  `/video/h264` è già aperto non superi il limite di client concorrenti (§4.5).
- **[misurato]** Il video **non si ricodifica** neanche con l'audio acceso: `-c:v copy`, e solo
  l'audio passa per AAC a 96 kbit/s. Il file con audio della prova pesa 395 kB contro 271 kB dello
  stesso girato senza: ~5 kB/s in più.

---

## L'orologio della distro detta il ritmo, misurato il 9 settembre 2026

Prova con un Pixel 10 vero collegato, quattro Altoparlanti finti ancora accesi dentro la distro e
un Sottofondo in una Zona. Sintomo osservato dall'Operatore: «i ms persi salgono in continuazione».

- **[misurato]** **L'orologio monotono della distro va il 3,5% piu lento di quello di Windows**:
  38,780 s di `/proc/uptime` contro 40,192 s misurati sul PC, cioe un rapporto di **0,96487**. Il
  clocksource in uso e `tsc` grezzo; `hyperv_clocksource_tsc_page` — quello sincronizzato con
  l'host — e disponibile e **non** selezionato.
- **[misurato]** Di conseguenza **snapserver legge la sorgente TCP a 169.797 B/s invece di
  176.400** (96,26%): scandisce le `async_read` da `chunk_ms` sul proprio orologio, e quel ritmo e
  il suo, non il nostro.
- **[misurato]** Il buffer di ricezione della sorgente resta quindi **fisso al tetto**:
  `skmem:(r128832,rb131072)`, cioe 128 KB ≈ **730 ms di audio fermi in coda**, permanenti. Da li in
  poi il ritmo non lo detta piu la `Cadenza`, lo detta la contropressione: lo scrittore resta
  stabilmente oltre mezzo secondo indietro al proprio orologio, riallinea, e i buchi salgono di
  **~25 ms al secondo per sempre**. Lo scarto oscilla fra -534 e +183 ms invece di stare fermo a
  +200 come nella misura con soli Altoparlanti finti.
- **[misurato]** ⚠️ **Quei riallineamenti non tolgono contenuto, ma l'audio non e liscio
  lo stesso.** `Cadenza` finge di aver scritto i blocchi saltati e **non fa avanzare il mixer**,
  quindi non si perde niente della forma d'onda prodotta: la timeline scorre al 96,5% del tempo
  reale. Il danno arriva a valle. Catturando ventuno secondi dal player di uno snapclient vero nel
  gruppo della Zona (`--player file:filename=...`), il tono di 440 Hz misurato **campione per
  campione** ha **917 discontinuita, cioe ~43 al secondo**, ciascuna da 0,45 ms (20 campioni) o
  0,91 ms (40 campioni), per un totale di **-457 ms su 21 s = -2,2% di forma d'onda asportata**.
  L'intonazione resta esatta (440,1 Hz), il livello e fermo (RMS 1024-1027): a tagliare e il
  client, per stare in pari. Su una sinusoide sono salti di fase, e si sentono come una raspa.
  → Guardare l'RMS secondo per secondo **non basta** per dire che un Flusso e integro: nasconde
  qualunque taglio piu corto del secondo. Si guarda la fase.
  → La cattura viene da un client **dentro la distro**, che condivide l'orologio storto del
  server: un telefono con l'orologio buono deve compensare uno scarto piu grande, non piu piccolo.
- **[misurato]** Quel che cresce, oltre ai tagli, e la **latenza**: `bufferMs` + `anticipoMs` + i
  730 ms di coda fanno **~2,9 s** contro i 2,2 s che `latenzaAttesaMs()` dichiara.
  → Da qui il contatore «ms persi» e stato rifatto: misurava una cosa vera (il passo perso col
  tempo reale) con una parola falsa (audio mancante), e nella barra di stato diceva «Flusso
  interrotto» acceso fisso. Adesso `Cadenza` espone un **ritmo** -- `ritardoMsAlSecondo` su una
  finestra mobile di trenta secondi -- e l'interfaccia lo mostra come «Flusso al 97%» solo sopra
  soglia. Un totale che sale non distingue «e successo mezz'ora fa» da «sta succedendo adesso».
  → Il nome «ms persi» promette all'Operatore un danno che non c'e. Misura una cosa vera (stiamo
  producendo piu lentamente del tempo reale) con la parola sbagliata.
- **[misurato]** La connessione RPC di controllo va a **`127.0.0.1:1705`** (`OPZIONI_RPC` in
  `snapcast/rpc.ts`), mentre le sorgenti audio vanno all'IP della distro. E esattamente il percorso
  che l'ADR 0010 vieta, e il commento a `suIndirizzoDistro` in `supervisore.ts` lo dice a due
  schermate di distanza. Regge solo perche `collegaEVerifica()` pretende una risposta vera a
  `Server.GetStatus` prima di dichiararsi acceso.

---

## Il primo pacchetto, misurato il 9 settembre 2026

`electron-builder` 26.15.3, Electron 33.4.11, `npm run dist:win`. Due file in `out/`: un
portabile e un installer NSIS, **111 MB** l'uno.

- **[misurato]** ⚠️ **L'`asar` NON rompe il thread audio**, ed era il sospetto principale.
  `PERCORSO_LAVORATORE` si ricava sostituendo dentro `import.meta.url`, quindi impacchettato
  diventa `file:///...\resources\app.asar\dist\shell\engine\audio\lavoratore.js`. Verificato che
  `lavoratore.js` sta **dentro** `app.asar` (`npx asar list`), che `app.asar.unpacked` **non
  esiste**, e che i tre scrittori risultano comunque `attivo`: Electron rattoppa `fs` anche per
  i worker. Niente `asarUnpack`, niente `asar: false`.
- **[misurato]** **ffmpeg in bundle viene davvero preferito al PATH.** L'app impacchettata
  riporta `N-126482-g903325e279-20260909` (la build LGPL messa in `vendor/ffmpeg`), mentre
  l'`ffmpeg` del PATH di questa macchina è `7.1.1-essentials_build-www.gyan.dev`. Le due
  stringhe diverse sono la prova che `radiciCandidate()` trova
  `<resources>/vendor/ffmpeg/ffmpeg.exe` prima di arrivare al ripiego -- cioè che lo shim
  Chocolatey e il suo ffmpeg orfano non entrano nel pacchetto.
- **[misurato]** Il portabile avviato da `out/` arriva a `clienti: 1`, `wsl: ok`,
  `snapserver: 0.35.0`, e tutti e tre gli scrittori `attivo` contro lo snapserver vero nella
  distro. Il percorso guscio → motore compilato → interfaccia compilata → thread audio → distro
  regge impacchettato.
- **[sorgente]** ⚠️ **Non è un eseguibile autosufficiente, e non può diventarlo.** Il pacchetto
  contiene tutto ciò che è nostro, ma non WSL2: serve Virtual Machine Platform, la
  virtualizzazione da BIOS e un riavvio (già scritto come conseguenza nell'ADR 0003). E non
  contiene ancora nemmeno la distro con snapserver dentro che quell'ADR prevede: `distro.ts`
  enumera le distro già installate e si aspetta che una venga scelta in Impostazioni, con
  `/opt/snapserver-0.35` scritto nel codice. Su un PC senza quella preparazione il pacchetto
  parte, mostra la finestra, e il server audio resta `spento`.

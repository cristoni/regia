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
- **[sorgente]** ⚠️ **Quei nomi arrivano nella 0.33**, non prima: il changelog di upstream elenca
  fra le modifiche della **0.33.0** (23 settembre 2025) «`tcp` section in `snapserver.conf`
  renamed to `tcp-control`» e «TCP streaming settings moved from `stream` to `tcp-streaming`».
  La tolleranza vista nella riga qui sopra e a senso unico: una 0.35 capisce ancora un file
  scritto per la 0.27, una 0.27 non puo capire un nome inventato nel 2025. `changelog.md`
  → E il motivo del cancello di versione dell'[ADR 0011](adr/0011-dove-gira-snapserver-e-una-sede-non-un-if.md):
  su Linux la versione la sceglie chi installa, e l'apt di Ubuntu 24.04 da la 0.27.0.
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
  che l'ADR 0010 vieta, e il commento a `suIndirizzoFlussi` in `supervisore.ts` lo dice a due
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
- **[misurato]** Il portabile avviato da `out/` **avvia snapserver da zero e ci suona dentro**.
  La prima misura non lo dimostrava e stava per essere scritta come se lo facesse: gli
  scrittori risultavano `attivo`, ma `ps -C snapserver` dava quel processo a **7h31m** di vita
  -- era quello della sessione `tsx` di prima, sopravvissuto al suo `wsl.exe` grazie a `setsid`.
  Il pacchetto lo stava soltanto **raggiungendo**.
  Rifatta dopo un `pkill -f snapserver` nella distro: il portabile parte, `clienti: 1`,
  `wsl: ok` (quel campo oggi si chiama `sede`, ed e la Sede WSL: vedi ADR 0011), e
  `server: spento` -- che e **giusto**, perche l'accensione e un comando
  dell'Operatore (`server.avvia`), non una cosa che succede al lancio. Mandato quel comando dal
  WebSocket come farebbe il pulsante, lo stato passa ad `acceso`, i tre scrittori tornano
  `attivo`, e nella distro compare un snapserver di **un secondo** di vita. Il percorso guscio →
  motore compilato → thread audio → `wsl.exe` → conf scritta nella distro → snapserver → socket
  regge impacchettato, da capo a fondo.
  → Il tranello si ripresentera: `setsid` fa sopravvivere snapserver a chi l'ha lanciato, quindi
  **una prova sul server audio non vale niente senza guardare l'eta del processo**.
- **[sorgente]** ⚠️ **Non è un eseguibile autosufficiente, e non può diventarlo.** Il pacchetto
  contiene tutto ciò che è nostro, ma non WSL2: serve Virtual Machine Platform, la
  virtualizzazione da BIOS e un riavvio (già scritto come conseguenza nell'ADR 0003). E non
  contiene ancora nemmeno la distro con snapserver dentro che quell'ADR prevede: `distro.ts`
  enumera le distro già installate e si aspetta che una venga scelta in Impostazioni, con
  `/opt/snapserver-0.35` scritto nel codice. Su un PC senza quella preparazione il pacchetto
  parte, mostra la finestra, e il server audio resta `spento`.
  → `distro.ts` **non esiste più**: da quando Regia gira anche su Linux quel codice sta in
  `sede.ts`, l'enumerazione è `distroInstallate()` e il percorso fissato è `BINARIO_SNAPSERVER`.
  Il resto della riga vale identico, e vale **solo per il pacchetto Windows**.

---

## Linux e la Sede: cosa si sa, e con quanta forza

Regia si compila e gira anche su Linux
([ADR 0011](adr/0011-dove-gira-snapserver-e-una-sede-non-un-if.md)), dove snapserver e nativo e
non serve nessuna distro. ⚠️ **La porta è stata eseguita su un kernel Linux vero, non su una
macchina Linux vera**, e la differenza non è un cavillo: la prova del 10 settembre 2026 gira
**dentro la distro `Ubuntu` di questa macchina**, cioè come root, senza sessione grafica, senza
telefoni, senza pacchetto e con l'orologio storto che la sezione «L'orologio della distro detta
il ritmo» ha già misurato. Tutto ciò che dipende da quelle cose sta ancora nell'elenco in fondo,
e ci sta per una ragione, non per prudenza. Se qualcuno aggiunge un `[misurato]` qui, dica su
quale macchina e con quale distribuzione.

### Letto nel sorgente

- **[sorgente]** `BUILD_SERVER` sta dentro `if(NOT WIN32)`, quindi **fuori da Windows il server
  si compila**. E la stessa riga su cui poggia l'[ADR 0002](adr/0002-il-server-audio-non-gira-nativo-su-windows.md),
  letta nella direzione opposta. `CMakeLists.txt`
- **[sorgente]** L'mDNS di snapserver **esiste su Linux**: l'opzione `BUILD_WITH_AVAHI` e
  dichiarata `ON` di default, e il blocco che la usa — quello che definisce `HAS_AVAHI` e
  `HAS_MDNS` — sta dentro `if(NOT WIN32 AND NOT ANDROID)`. Regia tiene `mdns_enabled = false` lo
  stesso, per le ragioni nella correzione dell'ADR 0002. `CMakeLists.txt`
- **[sorgente]** ⚠️ **Il pacchetto Debian di snapserver crea un utente di sistema `snapserver`**
  con casa `/var/lib/snapserver`, creata a `0750` e di proprieta di `snapserver:snapserver`.
  `extras/package/debian/snapserver.postinst`
  → E precisamente il motivo per cui il `datadir` non puo restare il default
  `/var/lib/snapserver`: su Linux Regia gira come l'utente che ha fatto login, e quella cartella
  esiste ed e esattamente non sua. Il `datadir` viene dalla Sede.
- **[sorgente]** ⚠️ **`snapserver.service` gira sotto `User=snapserver` / `Group=snapserver`**,
  con `Restart=on-failure`, `WantedBy=multi-user.target` e
  `ExecStart=/usr/bin/snapserver --logging.sink=system --server.datadir=${HOME} $SNAPSERVER_OPTS`.
  `extras/package/debian/snapserver.service`
  → Un `pkill -x snapserver` lanciato dall'utente che ha fatto login **non ha il permesso di
  segnalarlo**, e non deve averlo. Da qui il `systemctl is-active snapserver` che il supervisore
  fa quando l'avvio fallisce: dire chi tiene la porta, per nome, invece di lasciare un
  `address already in use` senza colpevole.
  ⚠️ Questi due file stanno in `extras/package/` di **upstream**: sono la sua idea di come
  impacchettare snapserver, non la prova di cosa spedisca l'archivio di Ubuntu. Chi lo verifica
  su una macchina vera sostituisca queste due righe con dei `[misurato]`.

### La Sede locale, misurata il 10 settembre 2026

Dentro la distro `Ubuntu` di questa macchina — kernel Linux vero — con Node 22.11.0 e snapserver
0.35.0 in `/opt/snapserver-0.35`.

- **[misurato]** `SedeLocale` trova il binario da sola, genera `snapserver.conf`, avvia il
  processo **nativamente** e si collega in JSON-RPC. Tre Zone più i non assegnati fanno quattro
  Flussi, e il server li dichiara tutti e quattro. Nessun `wsl.exe` in mezzo.
- **[misurato]** Nella stessa prova il ponte **non si apre** — `statoPonte()` torna vuoto — e le
  porte 1704, 1705, 1780 e 4953-4956 risultano in `LISTEN` su `0.0.0.0`. È il comportamento che
  l'ADR 0011 dichiara, visto invece che dedotto.
  ⚠️ **La metà che conta per i telefoni non è misurata.** Che le porte siano in ascolto su
  `0.0.0.0` è `[misurato]`; che un telefono le raggiunga dalla LAN è **dedotto**, e vale
  `[surrogato]`. La deduzione è vera su una Ubuntu vera e **falsa proprio qui**: dentro WSL2 in
  NAT snapserver ascolta su `0.0.0.0` da sempre, e il telefono non lo vede lo stesso — è
  letteralmente il guasto da cui nasce l'[ADR 0010](adr/0010-il-ponte-di-rete-fa-parte-di-regia.md).
  Resta da rifare, ed è la voce 1 dell'elenco qui sotto.
- **[misurato]** Il `datadir` finisce sotto la cartella di lavoro — `/run/user/0/regia/dati`, da
  `XDG_RUNTIME_DIR` — e non in `/var/lib/snapserver`, che fuori dalla distro un utente non
  potrebbe scrivere. La conseguenza scritta nell'ADR 0011 si vede nel percorso.
- **[misurato]** **Il percorso Windows non è cambiato.** Da Windows, con la Sede WSL puntata
  sulla distro `Ubuntu`: snapserver 0.35.0 trovato dentro la distro, avviato, RPC collegato,
  `indirizzoFlussi()` = `172.30.235.47` — l'IP della distro, **non** `127.0.0.1` — e ponte aperto
  e attivo su 1704, 1705 e 1780 verso quell'indirizzo. La Sede non ha tolto niente a chi già
  funzionava, ed è la metà della porta che si poteva rompere in silenzio.
- **[misurato]** ⚠️ **Un snapserver estraneo risponde come il nostro e non viene adottato.**
  Acceso a mano con una configurazione sua — cioè il caso dello `snapserver.service` che molte
  distribuzioni impacchettano — risponde a `Server.GetStatus` esattamente come risponderebbe il
  nostro, ma `adotta()` torna `false`, lo stato resta `spento` e il Diario nomina i Flussi che
  mancano («non ha i Flussi Ingresso, Non assegnati»). Senza questo controllo la serata sarebbe
  finita in «Stream not found» a ogni riconciliazione: gli stream li crea il file di
  configurazione, e quel file è il suo.
- **[misurato]** ⚠️ **Una shell di login sporca l'uscita dei comandi nella Sede.** `bash -lc`
  sorgente `/etc/profile` e `~/.profile`: con due `echo` aggiunti al profilo, l'uscita di ogni
  comando se li porta in testa. Per questo la ricerca di snapserver stampa righe **marcate**
  (`REGIA-SEDE-DOVE:`, `REGIA-SEDE-VERSIONE:`) e si leggono solo quelle; prendendo «la prima
  riga» Regia avrebbe usato il saluto del profilo come percorso del binario. Verificato che col
  profilo sporcato la Sede trova comunque `/opt/snapserver-0.35/usr/bin/snapserver` 0.35.0.
  → Dentro la distro dedicata dell'ADR 0003 il profilo non stampa mai niente, ed è per questo
  che su Windows la cosa non si era mai vista. Su un PC Linux di qualcun altro è la normalità.

### Il progetto intero su un checkout Linux pulito, 10 settembre 2026

- **[misurato]** Copia del repo dentro la distro `Ubuntu` (`/root/regia-linux`, **senza**
  `node_modules` né `dist`: quelli di Windows contengono binari che lì non si eseguono), poi
  `npm install` nativo. `npm run typecheck` passa su tutti e quattro i tsconfig, `npm run build`
  costruisce interfaccia, motore e guscio, e `npm test` chiude con **224 test, 224 passati, 0
  falliti, 0 annullati** — con Node 24.
- **[misurato]** ⚠️ **Con Node 22 lo stesso checkout non regge, e il guasto non è di Linux.** Il
  thread audio nasce da `new Worker()` con un percorso `.ts`, e il registrar di `tsx` **non entra
  nei worker**: su Node 22.11 il worker muore all'istante con `Unknown file extension ".ts" for
  .../lavoratore.ts`, `aspettaPronto()` non torna mai, e `avviaMotore()` resta appeso — tutte e
  nove le prove di `index.test.ts` si annullano senza un errore che spieghi il perché. Node 24 i
  tipi li toglie da sé e il worker parte. Su Windows non si era mai visto perché lì gira già Node
  24. → `engines.node` diceva `>=22` ed era falso per chi sviluppa: portato a `>=24`. Il
  pacchetto non ne soffre, dentro c'è `dist/**/*.js` già compilato.
- **[misurato]** **`scrittore.ts` chiamava `unref()` sulla scadenza dell'attesa di scarico**,
  contro la regola già scritta in `CLAUDE.md` («non chiamare `unref()` sul thread audio»). Quando
  la socket è parcheggiata `attendiScarico()` è una promessa che non si risolve mai e non
  trattiene niente: con la scadenza staccata non resta più nulla a tenere vivo il ciclo di
  eventi, e Node lo svuota **mentre lo scrittore sta ancora aspettando** — cioè esattamente il
  caso che quella funzione esiste per risolvere. Su Linux con Node 22 tre prove dello scrittore
  finivano in «Promise resolution is still pending but the event loop has already resolved»
  invece di misurare. Tolto l'`unref`: 20/20, e su Windows nessuna regressione.
  → Su Windows la risoluzione dei timer è 15,6 ms e c'è quasi sempre un altro timer in volo a
  tenere aperto il giro: il difetto era lì da prima della porta, ed è Linux ad averlo mostrato.

### Il pacchetto Linux, costruito il 10 settembre 2026

- **[misurato]** `npm run ffmpeg:prendi` su Linux scarica
  `ffmpeg-master-latest-linux64-lgpl.tar.xz` (il nome della release di BtbN è quello),
  estrae **solo** `<nome>/bin/ffmpeg` e `<nome>/LICENSE.txt`, e ne esce un binario
  `-rwxr-xr-x` di 142.622.632 byte che risponde a `-version`. La catena del `chmod` regge:
  il bit di esecuzione c'è, e la prova finale lo dimostra invece di darlo per buono.
- **[misurato]** `npm run dist:linux` arriva in fondo con esito 0 e produce
  `out/Regia-0.1.0-portabile.AppImage` (162 MB) e `out/regia-0.1.0.tar.gz` (154 MB).
- **[misurato]** Dentro il pacchetto c'è quello che deve esserci, e nei posti giusti.
  `resources/vendor/ffmpeg/ffmpeg` è un ELF x86-64 `-rwxr-xr-x` **e si esegue da lì**, ed è
  esattamente il percorso che `radiciCandidate()` calcola da `process.execPath` (l'eseguibile
  è `linux-unpacked/regia`). L'intestazione di `app.asar` elenca `dist/shell/shell/main.js`,
  `dist/shell/engine/index.js`, `dist/ui/index.html` e — la riga che conta —
  **`dist/shell/engine/audio/lavoratore.js`**: il thread audio nasce da dentro l'archivio su
  Linux come su Windows, senza copia in `app.asar.unpacked`.
- **[misurato]** L'AppImage si estrae e `AppRun` parte
  (`--appimage-extract-and-run`). ⚠️ Ma **la finestra non l'ha vista nessuno**: nella distro
  non c'è sessione grafica. Che l'applicazione si apra davvero resta da provare.
- **[misurato]** Senza `desktopName` la build avvisa che la finestra non si legherà alla voce
  di menu (è l'`app_id`/`WM_CLASS`). Messo `desktopName: it.regia.app` in `package.json` e
  `syncDesktopName: true` in `electron-builder.yml`, l'avviso sparisce e il `.desktop` dentro
  l'AppImage porta `StartupWMClass=it.regia.app` — letto estraendolo dal pacchetto.
- **[misurato]** Resta un avviso, ed è vero: «default Electron icon is used — reason=application
  icon is not set». Nel repo non c'è nessuna icona, né PNG per Linux né `.ico` per l'installer
  Windows. Il pacchetto si costruisce e parte lo stesso, con l'icona di Electron.

### Su una Ubuntu vera, 18 settembre 2026: il servizio di sistema si prende l'audio

La macchina è quella del committente: Ubuntu 26.04 (kernel 7.0), sessione GNOME, Node 24.21,
snapserver 0.35.0 compilato a mano in `/usr/local/bin` con una unit `snapserver.service`
**abilitata** (`User=snapserver`, una sola sorgente `pipe:///tmp/snapfifo` chiamata `default`),
Regia 0.2.2 installata dal `.deb` in `/opt/Regia`. È la prima prova della Sede locale con una
sessione grafica, un telefono vero e Regia che gira come l'utente e non come root. La sera del
16 settembre il committente ha riferito «le telecamere sì, l'audio no»; il 18 si è ripetuto il
giro con il motore headless (`npx tsx src/engine/avvia.ts`) contro lo stesso servizio attivo.

- **[misurato]** ⚠️ **Con `snapserver.service` attivo il nostro snapserver parte lo stesso, sordo.**
  `avvia()` scrive la configurazione in `/run/user/1000/regia/`, lancia `setsid snapserver -c …`
  e il processo **resta vivo**: nel suo `server.log` compaiono tre righe
  `[Error] … bind: Address already in use` (1705, 1780, 1704), ma snapserver 0.35 non esce —
  continua con le sole sorgenti `tcp://0.0.0.0:4953` e `:4954` in ascolto. `pgrep -x snapserver`
  lo trova, quindi il supervisore scriveva «avviato»; gli scrittori del thread audio si collegano
  alle sorgenti e le Zone risultano `attivo` con scarto ~200 ms. Audio che entra in un server che
  nessun telefono può raggiungere.
- **[misurato]** ⚠️ **Sulla 1705 rispondeva il server di sistema, e Regia lo prendeva per suo.**
  `collegaEVerifica()` scriveva «Collegato al server audio: 1 Flussi, 1 client conosciuti», poi
  «Server audio acceso: 2 Flussi, buffer 2000 ms…», stato `acceso`, e «Riconciliazione fallita:
  Internal error: Stream not found» ogni 5 s. Nel journal del servizio, la sera del 16: il Pixel 10
  (Snapdroid v0.29.0, Android 17) collegato da `192.168.1.7` e messo dal server nel gruppo dello
  stream `default` — una FIFO che nessuno scrive —, e `Group.SetStream … "Non assegnati"` →
  `Stream not found` **98 volte in 7 minuti**. È il «l'audio non funziona» della prova, e non
  c'entrano né la rete né il telefono: il telefono ha raggiunto la 1705 e la 1704 di questo PC
  dalla LAN, senza ponte, come l'ADR 0011 prevedeva — solo che dietro c'era il server sbagliato.
- **[misurato]** La riga di Diario del punto 9 dell'elenco qui sotto **non poteva comparire**:
  `colpaDiUnAltroServer` scattava solo se l'avvio falliva, e l'avvio non falliva. E il controllo
  «non ha i Flussi» di `adotta()` era giusto ma **guardava dopo aver copiato** `osservato` e
  `vivi`: a server `spento` l'interfaccia mostrava il Pixel con l'indirizzo `::ffff:192.168.1.7`,
  letto dal server estraneo.
  → La prova che il server sulla porta di controllo è il nostro è **che abbia i Flussi del
  progetto**, e ora la fa `collegaEVerifica()` a ogni collegamento (`ServerEstraneo`), prima di
  toccare qualunque stato. Rieseguito con lo stesso servizio attivo: `Avvia` fallisce in **1,8 s**
  con «snapserver e partito ma il server audio che risponde non e il nostro: non ha i Flussi
  "TEST", "Non assegnati" (ha "default"): le porte 1704, 1705 e 1780 le tiene un altro server
  audio, e il nostro non ha potuto aprirle. L'ho spento (dal suo log: "… bind: Address already in
  use …"). Attenzione: su questa macchina c'e un servizio "snapserver" gia attivo (systemd) …
  "sudo systemctl disable --now snapserver"», stato `caduto`, nessun nostro processo rimasto,
  scrittori tornati a `in collegamento`. `pgrep -x -u "$(id -u)" snapserver` dentro `bash -lc`
  distingue il nostro (utente `supremo`) dal servizio (utente `snapserver`).
- **[misurato]** Il client RPC parlava sempre a `127.0.0.1:1705` anche quando il progetto diceva
  un'altra `portaControllo`: il file di configurazione seguiva l'impostazione, il client no. Ora
  la segue, ed è quello che ha permesso la prova qui sotto.

### Il percorso audio intero su questa macchina, 18 settembre 2026

Regia headless con un progetto su porte alternative (2704/2705/2780, Flussi da 5953: quelle di
default le teneva il servizio), il **suo** snapserver, e due `snapclient` 0.35 nativi con
`--player file:filename=/dev/null` e `--hostID regia-finto-1/2`.

- **[misurato]** `server.avvia` → `acceso` in 1,5 s con tre Flussi (Ingresso, Cantina, Non
  assegnati), tutti `idle` a casa vuota. I due client compaiono come Altoparlanti con
  **l'indirizzo vero** (`127.0.0.1`, non «via ponte»), il riconciliatore li mette nei gruppi delle
  Zone assegnate alla prima passata, e quando i processi muoiono passano a `collegato: false`
  entro un secondo.
- **[misurato]** **Il suono di prova porta `Ingresso` a `playing` per tutta la durata, mentre
  `Cantina` resta `idle`**; a suono finito tutti e tre tornano `idle`. È il criterio «passano a
  `playing` mentre si suona» visto sulla Sede locale.
- **[misurato]** **Previsione del punto 2 confermata, per la metà che si è potuta misurare:** su un
  orologio solo `ritardoMsAlSecondo` è 0 (min e max su 40 s, due Zone) e `scartoMs` oscilla fra
  199 e 219 ms, cioè sta fermo attorno all'anticipo di 200 ms. Non è stata guardata la forma
  d'onda in uscita dai client.
- **[misurato]** **Punto 4: `snapclient` nativo si sincronizza con il snapserver della stessa
  macchina** — `diff to server [ms]: -0.005` e `0.01`, zero «No chunks available» in 40 s. Il banco
  su Linux può avere Altoparlanti finti nativi; il giro dalla distro non serve.
- **[misurato]** ⚠️ `snapclient --player null` **non è un lettore**: `null` è il nome di una
  scheda del lettore ALSA/PipeWire, e il client esce con 1 dicendo «PCM device "default" not
  found». Il lettore nullo è `file:filename=/dev/null`, come fa già `banco/altoparlanti-finti.ts`.
- **[misurato]** Il `.deb` bookworm di snapclient 0.35 su Ubuntu 26.04 cerca `libFLAC.so.12` e il
  sistema ha la `.so.14`: con un link simbolico parte (un avviso «Symbol … has different size»),
  e con il codec `pcm` FLAC non viene toccato. Per il banco è un ripiego, non una soluzione:
  `banco/prepara.ts` lo scarica in `/opt` e lì il problema si ripresenterebbe.
- **[misurato]** `npm test` su questa macchina: **260 test, 255 passati, 0 falliti, 5 saltati**
  (vogliono `ffprobe`, che il bundle non porta). Con `ffmpeg` fuori dal PATH ne saltano 9:
  `libreria.test.ts` e `index.test.ts` cercano `ffmpeg` nel PATH, non in `vendor/ffmpeg`.
- **[misurato]** Dal journal del 16 settembre: il `tar.gz` estratto sul Desktop **non parte** —
  «The SUID sandbox helper binary was found, but is not configured correctly … chrome-sandbox is
  owned by root and has mode 4755» — mentre il `.deb` (che il committente ha costruito a parte:
  `dpkg -l` lo elenca, `apt install ./regia_0.2.2_amd64.deb`) si installa in `/opt/Regia`, mette
  `chrome-sandbox` a root:4755, e la finestra si apre dal menu di GNOME. Il punto 10 qui sotto va
  riletto così.

### Da misurare su una macchina Linux vera

In ordine di quanto bloccano. Nessuna di queste è chiusa dalla prova del 10 settembre, e la
ragione per cui non lo è sta scritta accanto: alcune vogliono un telefono, alcune una sessione
desktop, alcune un orologio che non sia quello di WSL. Alcune sono **previsioni**, e sono scritte
come tali apposta, perché una previsione smentita è informazione e una previsione spacciata per
misura è un danno.

1. **I telefoni raggiungono snapserver senza ponte.** Che le porte siano in `LISTEN` su
   `0.0.0.0` è misurato; che un telefono ci arrivi no, e dentro WSL2 in NAT quella stessa
   condizione non basta (ADR 0010). Nessun telefono vero si è mai collegato a un snapserver
   Linux avviato da Regia. Da verificare insieme: che `AltoparlanteVivo.indirizzo` mostri
   l'indirizzo **vero** del telefono, che su Windows non si può avere.
   → **Quasi chiuso il 18 settembre** (sezione sopra): un telefono vero ha raggiunto la 1705 e la
   1704 di questo PC dalla LAN senza ponte — ma era il server di sistema a rispondere —, e due
   client nativi hanno raggiunto il nostro con l'indirizzo vero. Manca solo il telefono sul
   **nostro** server, che si prova appena il servizio di sistema è spento.
2. **Previsione: lo scarto d'orologio sparisce, e con lui tutta la sezione «L'orologio della
   distro detta il ritmo».** Quel blocco — l'orologio monotono della distro il 3,5% più lento di
   quello di Windows, snapserver che legge a 169.797 B/s invece di 176.400, i 730 ms di coda
   permanenti, i ~25 ms al secondo di ritardo e le ~43 discontinuità al secondo nella forma
   d'onda — nasce **tutto** dal fatto che il mixer e il server contano il tempo su due orologi
   diversi. Su Linux l'orologio è uno solo. Ci si aspetta quindi che il Passo del Flusso resti al
   100% e che lo scarto stia fermo. **Se non succede, la causa non era quella**, e ogni
   conclusione di quel blocco va riletta da capo.
   ⚠️ La prova del 10 settembre **non dice niente su questo**: girava dentro la distro, cioè
   sull'orologio storto, e per giunta senza misurare il Passo.
   → **Confermata a metà il 18 settembre**: `ritardoMsAlSecondo` 0 e `scartoMs` fermo fra 199 e
   219 ms per 40 s. Resta da guardare la forma d'onda in uscita dai client.
3. **La sincronizzazione e la latenza pulsante→suono fra telefoni veri**, con lo sweep
   dell'anticipo già in elenco fra le misure che restano al telefono vero. Su Windows lo sweep
   passa dal ponte; su Linux non c'è ponte, quindi non è la stessa misura ed entrambe vanno
   fatte.
4. **Se `snapclient` nativo si sincronizza con il snapserver della stessa macchina**, cioè se il
   banco di prova può avere Altoparlanti finti **nativi**. Su Windows non ci riesce — riporta uno
   scarto di un epoch Unix e scarta ogni chunk — ed è per questo che oggi girano dentro la
   distro. Se su Linux funziona, il banco cambia forma: niente distro nemmeno per il collaudo.
   → **Misurato il 18 settembre: funziona** (`diff to server` di ±0,01 ms). Il banco su Linux può
   avviare i client nativi; `prepara.ts` deve però fare i conti con `libFLAC.so.12` (sopra).
5. **L'anteprima di un Suono dalle casse del PC.** `anteprima.ts` cerca nell'ordine `pw-play`,
   `paplay`, `aplay`, `ffplay`, e su Windows passa invece da `Media.SoundPlayer` di PowerShell.
   **Nessuno dei quattro è mai stato eseguito**, e non si sa nemmeno quale di loro si trovi su
   una Ubuntu desktop appena installata — la prova del 10 settembre girava senza audio e senza
   sessione grafica, dove nessuno dei quattro avrebbe potuto funzionare comunque.
6. **`xdg-open` sulla cartella delle registrazioni.** `apri-cartella.ts` lo lancia e, se manca,
   dice che lo porta `xdg-utils`. Non è mai stato eseguito: serve una sessione grafica, che nella
   distro non c'è.
7. **Il ripiego quando `XDG_RUNTIME_DIR` non c'è.** Che il `datadir` finisca dentro
   `XDG_RUNTIME_DIR` è misurato (`/run/user/0/regia/dati`), ma quella era una sessione root
   dentro la distro. Da una sessione `ssh` o da una console senza sessione grafica la variabile
   può mancare, e allora si cade sulla cartella nel temporaneo legata all'utente: **quel percorso
   non è mai stato percorso**, e con esso il caso di due utenti diversi sulla stessa macchina.
8. **Il cancello di versione, dal lato che si vuole evitare.** Nessuno ha guardato una 0.27 vera
   leggere un file con dentro `[tcp-control]`: che la ignori **in silenzio** è la ragione per cui
   il cancello esiste, non una cosa osservata. Se qualcuno lo prova, la riga da scrivere qui è
   `[misurato]` e vale la pena scriverla anche se conferma.
9. **Il messaggio che il supervisore produce quando trova un `snapserver.service` di sistema.**
   Che un server estraneo non venga adottato è misurato, ed è la metà che protegge la serata. Non
   è misurata l'altra: quando l'avvio fallisce perché quel servizio tiene le porte, il supervisore
   chiede `systemctl is-active snapserver` e dovrebbe nominare il colpevole. Quella riga di Diario
   non l'ha mai letta nessuno, e su una macchina dove qualcuno aveva già fatto
   `apt install snapserver` è il fallimento più probabile alla prima accensione.
   → **Misurato il 18 settembre, ed era peggio della previsione**: l'avvio non falliva affatto,
   quindi la riga non poteva comparire e Regia si dichiarava accesa sul server di sistema. Ora la
   prova è sui Flussi, e la riga con `systemctl` compare — in 1,8 s — anche all'avvio di Regia,
   quando `adotta()` trova il servizio (sezione sopra, e ADR 0011, correzione).
10. **Il pacchetto Linux: costruito, mai lanciato con uno schermo davanti.** La build c'è (vedi
    la sezione qui sopra) e dentro c'è tutto quello che deve esserci. Quello che manca è
    l'unica cosa che la build non può dire: che l'AppImage **si apra** su un desktop vero —
    con FUSE 3 di mezzo, dove un AppImage di tipo 2 non parte finché qualcuno non installa
    `libfuse2`, ed è la ragione per cui il `tar.gz` gli sta accanto come ripiego. Nella distro
    non c'è sessione grafica: si è potuto verificare che l'archivio si estrae e che `AppRun`
    parte, non che la finestra compaia.
    → **Il 16 settembre, su questo desktop**: il `tar.gz` estratto non parte per il
    `chrome-sandbox` senza SUID (journal: «is not configured correctly … owned by root and has
    mode 4755»); l'AppImage è stato montato da udisks invece che eseguito (serve il bit di
    esecuzione e, su Ubuntu 26.04, il FUSE giusto — non è stato guardato oltre); il `.deb`
    costruito a parte si installa e la finestra si apre. È il `.deb` ad aver retto la prova.
    → Resta anche l'icona: la build avvisa «default Electron icon is used», e finché nel repo
    non c'è un file, Regia si presenta con l'atomo di Electron.
    → E resta da decidere se snapserver vada dichiarato come dipendenza di un `.deb` — oggi il
    `.deb` non è nemmeno un bersaglio — con gli obblighi GPL-3.0 che ne verrebbero: vedi la
    correzione dell'ADR 0003.

## La linea temporale del video registrato, misurato l'11 settembre 2026

Diagnosi di tre registrazioni difettose fatte sul campo (router dedicato, `.exe` portatile) e cura,
tutto **[misurato]** con esperimenti ffmpeg sul binario in bundle (`vendor/ffmpeg/ffmpeg.exe`,
N-126482) e su due file veri (`Ingresso_Telecamera-3_20260911_163554.mp4` e `..._163657.mp4`).
⚠️ **Tutte queste misure usano audio sintetico muto e un H.264 sintetico**: il sincrono di
contenuto A/V e il comportamento contro la telecamera vera (irraggiungibile in queste prove:
`192.168.1.3:4444` rifiutava le connessioni) restano **da verificare**.

- **[misurato]** **La registrazione a due ingressi affamava il video, ed era una diapositiva.**
  Con `-use_wallclock_as_timestamps 1` sul video (grezzo H.264) e l'audio della pompa come secondo
  ingresso, ffmpeg dava al video un DTS all'epoch (~1,7·10⁹ s) e all'audio un DTS da conteggio
  campioni (~0). Il suo muxer ordina per DTS: drenava sempre l'audio e leggeva il video a ~3,9 fps,
  poi scaricava tutto l'arretrato in un lampo alla chiusura. Nei due file veri: consegna «viva» a
  4,49 fps (WiFi 100%) e 3,87 fps (WiFi debole) — **indistinguibili**, e uguali al ciclo limite
  sintetico a consegna perfetta (3,9 fps): **il WiFi non c'entrava**, era il muxer.
- **[misurato]** **Nessuna impostazione di interleave colma il divario.** `-max_interleave_delta 0`
  e `-thread_queue_size 4096` falliscono entrambi su 90 s: il divario è da un epoch (~1,7·10⁹ s) e
  il tetto di `max_interleave_delta` è ~2147 s. Portare l'audio all'epoch (`wallclock` su tutti e
  due gli ingressi) sistema il video ma **rompe l'audio**: `start_time` all'epoch, 4700+ correzioni
  di DTS non monotono, audio presente **solo nell'ultimo segmento**. Anche una catena di due ffmpeg
  (uno che rifà mpegts) porta l'epoch fino in fondo, con o senza `-copyts/-start_at_zero/-avoid_negative_ts`.
- **[misurato]** **La cura: i PTS li mette Regia.** Un muxer MPEG-TS minimo (`ts.ts`) dà a ogni
  fotogramma un PTS preso dall'orologio al momento dell'emissione, riportato a zero sul primo. Un
  solo ffmpeg legge quel TS (`-f mpegts`) più l'audio della pompa. Misurato su 90 s a
  `-segment_time 30`: **3 segmenti da ~900 fotogrammi, mediana 42-46 ms, nessuna raffica di coda,
  audio in ogni segmento, zero avvisi**, contro i ~327 ms di mediana e la raffica da 2340
  fotogrammi del percorso vecchio. Identico al controllo solo-video. La segmentazione e il percorso
  di ripresa non cambiano: è sempre un ffmpeg che segmenta da sé.
  → Assunzione ereditata: **una slice per fotogramma**. Lo `SpezzatoreAnnexB` emette su ogni NAL di
  slice, e sul telefono è misurato che ce n'è una sola per fotogramma. Una sorgente multi-slice
  darebbe più PES per fotogramma con PTS diversi — ma la stessa assunzione la fa già il conteggio
  degli fps.
- **[misurato]** **«Niente audio» era falso.** Il file `..._163657.mp4` ha una traccia AAC mono
  vera (53,4 s, media −25,4 dB): presente ma **piano**, non muto. Se in riproduzione non si sente,
  è il livello o il lettore, non il contenitore.
- **[sorgente]** **Un baco collaterale, corretto nello stesso passaggio.** In `registratore.ts`, se
  `apriAudio()` falliva in modo sincrono, `portaAudio` restava impostata: ffmpeg partiva con
  `-map 1:a` verso una pompa che ascolta ma non parte mai, si bloccava, veniva ucciso dopo 5 s e
  lasciava un MP4 senza `moov` (illeggibile), più il server della pompa mai chiuso. Ora la `catch`
  azzera `portaAudio` e chiude la pompa.
  → **Da verificare sul campo [surrogato]**: che una vera registrazione dalla telecamera vera esca
  fluida e in sincrono A/V. Le misure qui sopra provano la cadenza dei PTS e la tenuta della
  segmentazione, non il sincrono del contenuto.
- **[misurato]** **Un primo fotogramma chiave lontano lasciava il file VUOTO, in silenzio.** Se il
  primo IDR sta oltre la finestra di sondaggio di ffmpeg (provato con GOP da 10 s e ingresso preso
  a metà), `avformat_find_stream_info` non trova le dimensioni («Could not find codec parameters …
  unspecified size»), il segmentatore non scrive l'intestazione («dimensions not set») e **zero
  segmenti escono su disco** — identico con l'ingresso H.264 grezzo di prima e con l'MPEG-TS: era
  un limite preesistente, non una regressione del muxer. La cura sta nel `MuxTs`: **trattiene
  tutto fino al primo fotogramma chiave** (che sul telefono porta con sé SPS e PPS, misurato in
  annexb.ts), così i primi byte che ffmpeg vede sono sempre SPS+PPS+IDR. Rifatta la prova
  patologica dopo la cura: 1 segmento, 299 fotogrammi, 10,6 s — tutto il girato dal chiave in poi.
- **[misurato]** **Con il trattenimento sparisce anche il rumore d'avvio.** Un ingresso MPEG-TS
  preso a metà GOP produce le STESSE righe del decodificatore h264 del percorso grezzo
  («non-existing PPS», «no frame!») — 88 righe, tutte già filtrate da `RUMORE_DI_AVVIO` — non le
  lamentele del demuxer TS. Con il trattenimento non ne arriva più nessuna: resta una sola riga,
  «Guessed Channel Layout: mono», che viene dall'ingresso **audio** (invariato) e c'era anche prima.
- **[sorgente]** **Lo zero dell'audio si è spostato con lui.** La pompa parte alla prima emissione
  del muxer (il primo chiave), non più al primo byte grezzo, e `avvia()` svuota la coda dei
  campioni arrivati prima: senza, l'audio aprirebbe il file fino a mezzo secondo (`CODA_MASSIMA_MS`)
  più vecchio del primo fotogramma, cioè in ritardo per tutta la ripresa.

## Il portabile che «non si apre»: due guasti intrecciati, misurato il 12 settembre 2026

- **[misurato]** **«ffmpeg.dll non è stato trovato» al lancio del portabile non è un pacchetto
  rotto, e `ffmpeg.dll` non è il nostro ffmpeg.** È la dll di Electron che sta accanto a
  `Regia.exe`. Il portabile 0.2.0 che dava quell'errore è risultato integro da cima a fondo:
  `7z t` pulito sul contenitore NSIS e sul payload `app-64.7z`, `ffmpeg.dll` presente dentro
  (2.927.616 byte, identica a `win-unpacked/`). La prima analisi si era fermata qui e aveva
  concluso che l'exe rilanciato da solo «parte senza una piega»: **falso** — partivano i
  processi, mai la finestra. La correzione sta due punti più sotto.
- **[sorgente]** **Ogni lancio dello stesso portabile estraeva nella STESSA cartella di `%TEMP%`,
  e per prima cosa la cancellava.** `portable.nsi` di app-builder-lib fa `RMDir /r $INSTDIR` e poi
  estrae; senza `unpackDirName` il nome è un ksuid fisso per build (`NsisTarget.js:247`), quindi
  due lanci dello stesso `.exe` condividono la cartella. Un secondo lancio mentre il primo è
  aperto — o ancora in estrazione: ~10 s senza finestra né progresso, e il doppio clic viene da sé
  — porta via i file all'istanza viva; i file già mappati in memoria sono bloccati e restano, gli
  altri spariscono, e il loader di Windows mostra la dll mancante prima che parta una riga nostra.
  `CRCCheck off` e l'estrazione via plugin fanno sì che nessun passaggio se ne lamenti.
- **[misurato]** Alle 13:32 del 12 settembre c'erano **due stub NSIS vivi insieme** (le loro
  `%TEMP%\ns*.tmp` sono sparite solo uccidendo i processi Regia che aspettavano in `ExecWait`):
  è la firma di due lanci sovrapposti, ed è il quadro in cui l'errore è comparso. Con la 0.1.0
  non era mai successo perché non era mai capitato di sovrapporre due lanci, non perché quel
  pacchetto ne fosse immune — il ksuid cambia a ogni build, quindi 0.1.0 e 0.2.0 non collidono
  fra loro, ma ciascuna collide con se stessa.
- **[sorgente]** **La cura è `unpackDirName: true`, e la documentazione dice l'opposto.** La doc
  di electron-builder promette la cartella per-lancio con `false`; in 26.15.3 il codice mette il
  ksuid fisso per ogni valore falsy o stringa, e solo `true` lascia il ripiego su
  `$PLUGINSDIR\app`, unica per lancio e pulita da NSIS. `requestSingleInstanceLock` in `main.ts`
  chiude da sola la seconda istanza appena parte; non poteva evitare il `RMDir`, che avviene
  nello stub prima di Electron. Il costo della cartella per lancio è zero: l'estrazione piena a
  ogni avvio c'era già, il nome fisso non faceva da cache.
- **[misurato]** **Il guasto vero, quello che rendeva i lanci «a vuoto»: un motore dimenticato
  sulla porta 7333.** Un `tsx src/engine/avvia.ts` del giorno prima (partito alle 19:42 dell'11
  settembre) teneva `127.0.0.1:7333`. Il motore del pacchetto prendeva `EADDRINUSE` — il
  `Servitore` lo rifiuta correttamente — ma nel guscio `void principale()` non aveva catch: la
  promessa affondava muta, la finestra (che nasce solo **dopo** `avviaMotore`) non arrivava mai,
  e il processo restava vivo tenendo il lucchetto di singola istanza. Da lì ogni lancio
  successivo moriva all'istante, in silenzio, sul lucchetto. È questo che ha invitato i doppi
  clic da cui è nata la corsa del punto sopra: i due guasti sono uno la causa dell'altro.
- **[misurato]** **La firma dello zombie, buona per la prossima volta:** 3 processi `Regia`
  (main, gpu, utility) e `MainWindowHandle` a zero = motore mai arrivato in fondo all'avvio,
  nessun renderer. Un'istanza sana ne ha 4 o più e una finestra «Regia». Il portabile uscito da
  console senza stampare niente = lucchetto occupato da uno zombie.
- **[misurato]** **La cura nel guscio: il fallimento parla.** `principale()` ora ha un catch che
  mostra `dialog.showErrorBox` (con un messaggio dedicato per `EADDRINUSE`), ferma l'eventuale
  motore e esce con `app.exit(1)`. Provato dal vivo nei due versi: con la 7333 occupata da un
  finto ascoltatore compare il riquadro d'errore e il processo muore invece di fare lo zombie;
  con la porta libera il portabile apre la finestra (4 processi, `MainWindowTitle` «Regia»,
  7333 in ascolto dal pid giusto) e la X la chiude pulita, stub NSIS compreso.

## Registrazioni difettose dalla prova reale, misurato il 13 settembre 2026

La prova del committente (rete Wi-Fi dedicata, PC + due telefoni, due registrazioni in
contemporanea) ha dato un file buono dal telefono vecchio (5 s di silenzio in testa, resto ok) e
uno inutilizzabile dal telefono nuovo (video bloccato, audio robotico). Tutte le misure sotto sono
fatte contro i telefoni veri (`.7` = nuovo, Pixel a sensore 4K, obiettivo attivo `0:2`; `.16` =
l'altro), riproducendo la pipeline di registrazione con i moduli veri `MuxTs`/`PompaAudio`.

- **[misurato]** **Il silenzio in testa (~5 s) è una corsa fra l'orologio della pompa e il
  collegamento di ffmpeg.** `PompaAudio.avvia()` fa partire `inizioMs` sul primo keyframe, ma
  ffmpeg apre gli ingressi in sequenza: sonda l'MPEG-TS su `pipe:0` (default `analyzeduration` ~5 s)
  e **solo dopo** apre l'ingresso audio. Misurato: `avvia()` a ~1300 ms, ffmpeg connesso alla socket
  audio a ~6500 ms; `(connect − avvia) = 5203 ms`, e `silenzio inventato + 500 ms di coda = 5222 ms`
  — coincidono al millisecondo su più esecuzioni. Per quei ~5 s `giro()` esce subito (`!this.presa`)
  ma l'orologio avanza; al collegamento il debito è ~5 s, la coda ne tiene 500 ms, il resto esce come
  un unico blocco di silenzio in testa.
- **[misurato]** **La cura è accorciare il sondaggio di ffmpeg, non spostare lo zero dell'audio.**
  Con `-analyzeduration 200000 -probesize 100000` sull'ingresso `pipe:0`, `(connect − avvia)` scende
  a ~516 ms, il collegamento cade dentro i 500 ms di coda, e il **silenzio inventato va a 0,00 s**;
  tracce 13,94 s video / 13,83 s audio (scarto 110 ms). Ancorare invece `inizioMs` al collegamento
  eliminerebbe il silenzio ma sfaserebbe l'audio di ~5 s in avanti (lo zero del video resta al primo
  keyframe): il comportamento attuale mantiene la sincronia, perde solo i 5 s iniziali. Il
  `probesize` va tenuto sopra un keyframe (un IDR a 1280×720 è grande).
- **[misurato]** **Il telefono nuovo cambia risoluzione a metà stream con `streamRes` adattivo.**
  In 30 s di `/video/h264` da `.16` (ad `auto`) compaiono due SPS distinti, **960×720 e 800×608**; da
  `.7` due geometrie, **1024×576 e 720×480**. La struttura resta pulita (`7,8,5` a ogni keyframe, una
  slice per fotogramma). Lo switch è **intermittente**, guidato dalla luce via l'auto-fps: alcune
  finestre da 20-30 s non lo mostrano.
- **[misurato]** **Fissare una risoluzione concreta blocca la geometria a una sola.** Inviato
  `/?resolution=WxH`: su `.16` a 960×720 → 30 SPS su 30 s tutti 960×720 byte-identici; su `.7`
  provati 960×720, 1280×720, 800×608 → ciascuno una sola geometria su 20 s. `.7` regge anche 960×720
  benché non sia tra le native del suo obiettivo, ma **1280×720 è nativo** ed è la scelta adottata.
- **[sorgente]** **Il contratto del parametro risoluzione di android-ip-camera** (letto in
  `StreamingService.kt`, `desiredSize()` e l'endpoint di controllo): `?resolution=WxH` scrive la
  preferenza `stream_res` (concreta); `?resolution=low|medium|high` tocca solo il *target* di
  `stream_res="auto"` (`low`→800×600, `medium`→960×720, `high`→1280×720); `?resolution=auto|max`
  rimette l'adattivo. Con `auto`, la `ResolutionStrategy` della camera (`FALLBACK_CLOSEST_HIGHER_THEN_LOWER`
  + `PREFER_HIGHER_RESOLUTION_OVER_CAPTURE_RATE`) sceglie una nativa vicina al target e può cambiarla
  a ogni rebind — da cui lo switch. Valori non riconosciuti tornano `200` ma vengono ignorati.
- **[misurato]** **Il congelamento del video è dipendente dal lettore, non una corruzione.**
  Iniettato uno switch a metà ripresa (`800×608 → 1280×720`): il file contiene le due geometrie, ma
  ffmpeg lo decodifica pulito (reinizializza sull'SPS in-band; `-err_detect explode` = zero
  corruzione). Il contenitore MP4 con `-c:v copy` dichiara però **una sola** dimensione (l'`avcC` del
  primo keyframe): i lettori rigidi (Windows Media Player / Foto, pipeline hardware) la onorano e si
  bloccano al cambio. È il sintomo visto dal committente.
- **[misurato]** ⚠️ **L'audio robotico è un guasto a sé, indotto dal carico, NON collaterale del
  video.** A singolo dispositivo l'audio è sempre liscio, anche iniettando lo switch. In **doppia
  registrazione** (`.7`+`.16`), con geometria fissata e video pulito, l'audio di `.7` esce con
  silenzio sparso (gap a 0,18 / 0,74 / 1,14 / 1,64 / 2,1 / 3,5 / 4,3 / 5,1 / 5,5 / 7,6 s…), 1,42 s
  inventati in 60 s; `.16` nello stesso run 0 s. **Non è la rete**: sotto doppio carico video la
  consegna audio di `.7` è nominale (2 inter-arrivi > 150 ms in 40 s) e la slittatura di un timer
  100 ms è ≤ 16 ms. Causa probabile: contesa sul thread principale, dove la pompa convive con 2×
  flussi video, 2× `MuxTs` e 2× scritture su stdin di ffmpeg — quando `campioni()` ritarda,
  `ultimoCampioneIl` invecchia e `giro()` inietta silenzio (`quiete > PAZIENZA_MS`). **Cura non
  ancora scelta** (vedi `.scratch/registrazioni-difettose/piano.md`, punto 5).

## I Suoni che «non trovano ffmpeg» sul PC Linux, misurato il 18 settembre 2026

- **[misurato]** ⚠️ **La libreria dei Suoni cercava ffmpeg nel PATH e ignorava il binario in
  bundle.** `new LibreriaSuoni(suoni, cache)` lasciava il default `'ffmpeg'`; `trovaFfmpeg()` lo
  usavano solo la registrazione e il Setup. Su Windows non si vedeva perché lo shim di Chocolatey
  sta nel PATH; sul PC della casa (Ubuntu 26.04, nessun ffmpeg di sistema) ogni import finiva in
  «non riesco a decodificare "storm.mp3": ffmpeg non trovato», con `/opt/Regia/resources/vendor/
  ffmpeg/ffmpeg` presente ed eseguibile. Ora il motore passa alla libreria `trovaFfmpeg()?.percorso`
  e il PATH resta il ripiego. Verificato dal vivo: `POST /api/suoni?nome=storm.mp3` → 200,
  `durataMs` 10000, `zona.suona` porta lo stream `TEST` a `playing` per 12 campioni su 12, uno
  snapclient nativo locale in gruppo con «diff to server» 0 ms. I test della libreria (8) ora
  girano anche qui: prima si saltavano proprio sulla macchina dove contavano.
- **[misurato]** ⚠️ **Un Altoparlante resta `collegato` per minuti dopo che la rete sotto di lui
  è sparita.** Il cavo verso il router dedicato ha perso la portante alle 15:02:49; alle 15:11 il
  Diario non aveva detto niente e lo stato riportava ancora `"moto g 5G", collegato: true,
  192.168.1.2`. La socket di snapserver verso il telefono era viva solo per il kernel: `ss -tni`
  mostrava `Send-Q 62604`, `bytes_retrans 64644`, `backoff 12`, `lastrcv` ~9 minuti, e l'indirizzo
  locale era ancora `192.168.1.6`, che l'interfaccia non ha più. Snapserver se ne accorge solo
  quando il TCP rinuncia alle ritrasmissioni (`tcp_retries2` = 15, cioè un quarto d'ora abbondante):
  non manda keepalive e non usa le `Time` mancanti del client come segno di vita. Il «collegato»
  dell'istantanea è quindi una proiezione dello stato di snapserver, non una prova che i byte
  arrivino. Cura non scelta: un orologio nostro sul `lastSeen` di ogni client, o `Server.GetStatus`
  con `client.lastSeen` confrontato al nostro orologio.
- **[misurato]** **Il router dedicato dà il DHCP sul cavo e usa `192.168.1.0/24`, lo stesso del
  Wi‑Fi di casa.** Journal del 18 settembre: `dhcp4 (enp2s0): new lease, address=192.168.1.6`
  alle 14:50:10 mentre `wlp3s0` teneva `192.168.1.17` da `Vodafone-Supremo`. Due interfacce sulla
  stessa sottorete: il kernel sceglie una rotta sola per `192.168.1.0/24`, e quale delle due vince
  dipende dalla metrica, non dal cavo. Con il cavo staccato tutto il `192.168.1.x` va sul Wi‑Fi di
  casa. Alle 15:10 una scansione ARP del Wi‑Fi di casa non trovava né `.2` né `.10`; alle 15:35 il
  telefono rispondeva a `.10` **sul Wi‑Fi di casa** (MAC randomizzato `26:3a:3c:…`, porta 4444
  aperta, ping 120–170 ms: si stava svegliando). Un telefono in doze può non rispondere all'ARP
  per minuti: una scansione negativa non prova che non ci sia. Finché le due reti condividono la
  sottorete, l'indirizzo da scrivere in Snapdroid è quello che Regia mostra in Setup **per
  l'interfaccia che il telefono condivide**.
- **[misurato]** ⚠️ **`npm test` non finisce se sulla macchina è vivo uno snapserver sulle porte di
  default, anche orfano.** Su Linux la Sede è il PC, quindi i motori dei test parlano con ciò che
  ascolta davvero su 1705 e sui Flussi 4953+. Con lo snapserver di una Regia precedente ancora
  acceso (setsid: sopravvive alla chiusura, ed è voluto) `index.test.ts` passa tutti i suoi test e
  poi il processo non esce: una volta è arrivato a 331 s e la suite è finita rossa; con la Regia
  viva accanto, i test le hanno anche ucciso e fatto riavviare snapserver tre volte. Con
  `pkill -x snapserver` prima: 260 test, 255 passati, 5 saltati (registrazione, vogliono `ffprobe`
  nel PATH), 0 falliti, esito 0. Prima della suite: `ss -ltn | grep 1705` deve essere vuoto.


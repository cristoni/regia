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

## snapclient.exe come banco di prova

- **[misurato]** `snapclient.exe` 0.35.0 parte su questa macchina e restituisce 0. Sintassi:
  `snapclient [opzioni...] [url]` con url `<tcp|ws|wss>://host`.
- **[misurato]** Serve sempre passare `--hostID` esplicito per avere N client distinti sulla stessa
  macchina.
- **[surrogato]** ⚠️ Le misure sui client finti sono state prese **in ciclo di riconnessione, mai
  in streaming**: il player viene costruito solo dopo una connessione riuscita, quindi decodifica e
  timer non sono nel conto. Il costo reale di otto Altoparlanti finti e ancora ignoto.

---

## Le cinque misure che restano al telefono vero

In ordine di quanto bloccano:

1. **Raggiungibilita LAN → WSL su una macchina in configurazione di fabbrica.** L'unica delle
   cinque che resta davvero bloccante. Vedi
   [ADR 0003](adr/0003-regia-si-porta-la-propria-distro-wsl.md): tutte le misure di rete sono state
   prese su questa macchina, dove `networkingMode=mirrored` era **gia** attivo. Windows 11 pulito e
   in NAT.
2. **Sweep dell'anticipo** a 50 / 100 / 200 / 400 / 1000 ms, dieci minuti ciascuno, da Node su
   Windows attraverso il ponte, con tutte e tredici le socket, registrando la **distribuzione**
   delle magnitudini di risincronizzazione e non il loro numero.
3. **Quale porta di controllo usa Snapdroid** (1705 o 1780): decide se `[tcp-control]` va acceso.
4. **Se il telefono emette B-frame.** Se li emette, gli MP4 registrati escono con PTS uguale a DTS
   e l'ordine di presentazione sbagliato.
   `ffmpeg -bsf:v trace_headers` su 100 KB presi dal telefono.

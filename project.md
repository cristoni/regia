# "Regia" – Applicazione di controllo per casa degli orrori

## Documento di progetto per lo sviluppo

Versione 1.0 – settembre 2026
Committente: organizzazione evento Halloween
Destinatario: sviluppatore/team di sviluppo

---

## 1. Sintesi

Serve un'applicazione per **Windows 11** che permetta a un operatore ("la regia"), da un unico PC, di:

1. Vedere in tempo reale il video di più smartphone Android posizionati nelle stanze della casa degli orrori.
2. Far partire effetti sonori in stanze specifiche, riprodotti da altri smartphone Android collegati a casse amplificate.
3. Registrare video (e audio) dagli smartphone-telecamera quando serve.
4. Configurare tutto questo in modo guidato, raggruppando i dispositivi in **zone** (stanze) facili da creare, modificare ed eliminare.

I dispositivi sul campo sono esclusivamente smartphone Android con due app open source già esistenti:

- **Snapdroid** (client Snapcast) per l'audio: https://github.com/snapcast/snapdroid
- **Android IP Camera** per il video: https://github.com/DigitallyRefined/android-ip-camera

Il PC di regia esegue il server audio **Snapcast** (https://github.com/snapcast/snapcast) e l'applicazione oggetto di questo documento. Non è previsto altro hardware.

Non serve nessuna connessione a internet: tutto gira sulla rete Wi-Fi locale.

---

## 2. Contesto e vincoli

### 2.1 Scenario d'uso

- Una casa con 3–8 stanze. In ogni stanza uno o più telefoni: alcuni fanno da telecamera, altri da altoparlante (collegati via jack a una cassa), eventualmente lo stesso telefono fa entrambe le cose.
- Un operatore in una stanza nascosta, davanti al PC, guarda i video, e al momento giusto preme un pulsante per far partire un urlo, una risata, un botto nella stanza dove si trovano i visitatori.
- L'evento dura alcune ore, con gruppi di visitatori che entrano ogni pochi minuti. L'operatore non è necessariamente tecnico.
- Il setup viene fatto nel pomeriggio da persone con competenze informatiche di base; le prove vengono fatte qualche giorno prima.

### 2.2 Vincoli tecnici verificati sul campo

Durante i test preliminari sono emersi questi punti, che vincolano l'architettura:

| Verifica | Risultato | Conseguenza per il progetto |
|---|---|---|
| Snapserver su Windows | Le release ufficiali forniscono binari Windows **solo per il client**; il server va compilato da sorgente (documentazione "Windows (vcpkg)") oppure eseguito in WSL2/Docker. | Vedi §4.2: la scelta del metodo di esecuzione del server è la prima decisione di progetto. |
| Snapdroid con codec FLAC (default) su Pixel 10 / Android recente | Nessun audio. Con `codec=pcm` funziona. | Usare PCM (o valutare Opus) come codec dei flussi. Rendere il codec configurabile. |
| Flussi audio intermittenti (pipe alimentata solo quando parte un suono) | Il flusso passa idle→playing a ogni suono; i client perdono la sincronia e smettono di suonare finché non si riconnettono. | **Ogni zona deve avere un flusso audio continuo**: silenzio o sottofondo quando non c'è nulla da riprodurre, effetti mescolati dentro. Mai interrompere il flusso. |
| Named pipe in /tmp su Ubuntu | Bloccate da `fs.protected_fifos` anche per root. | Non usare named pipe. Usare la sorgente **TCP** di Snapserver (§4.3). |
| Client Snapweb nel browser | Ogni scheda aperta con Play attivo è un client audio; schede dimenticate producono audio doppio. | L'app non deve usare Snapweb come player; solo eventualmente come pannello di diagnostica. |
| Registrazione video dal pannello web di Android IP Camera | Ricodifica nel browser: scatti e fotogrammi persi anche con risoluzione bassa. | Registrare **lato PC** con ffmpeg copiando il flusso H.264 senza ricodifica (`-c copy`). |
| Telefoni Android in background | Risparmio energetico interrompe stream e client. | La guida di setup deve far impostare "batteria senza restrizioni", notifiche attive, telefono in carica. L'app deve rilevare e segnalare i dispositivi caduti. |
| `localhost` su Windows | Risolve in IPv6 `::1`; Snapserver rispondeva solo su IPv4. | Usare sempre indirizzi IPv4 espliciti nelle chiamate interne. |
| WSL2 e rete | Servono `networkingMode=mirrored` e regole firewall (porte 1704, 1705, 1780) perché i telefoni raggiungano il server. | Se si sceglie WSL2, l'app deve verificare e guidare questa configurazione. |

---

## 3. Requisiti funzionali

### 3.1 Zone

- Una **zona** rappresenta una stanza o un punto della casa. Ha: nome, colore/icona, elenco di dispositivi audio, elenco di dispositivi video, sottofondo audio opzionale, volume, elenco di effetti sonori disponibili (default: tutti).
- Operazioni: crea, rinomina, cambia colore, riordina, elimina (con conferma se ha dispositivi assegnati), duplica.
- Una zona può non avere dispositivi audio (solo video) o non avere video (solo audio).
- Numero di zone: da 1 a 12. L'interfaccia deve restare usabile con 8 zone su un monitor 1080p.

### 3.2 Dispositivi audio (client Snapdroid)

- L'app mostra la lista dei client Snapcast connessi al server, in tempo reale, con: nome, indirizzo IP, stato (connesso/disconnesso), volume, zona assegnata, latenza.
- Assegnazione a una zona: trascinamento, oppure menu a tendina sulla riga del dispositivo, oppure dalla scheda della zona ("aggiungi dispositivo"). Un client appartiene a una sola zona.
- Rinomina del client dall'app (il nome viene scritto sul server Snapcast, così è persistente).
- Volume e muto per singolo client e per zona.
- **Funzione "Identifica"**: premendo un pulsante accanto a un client, il server riproduce un suono breve solo su quel client, così chi sta configurando capisce quale telefono è. Questo è il meccanismo principale con cui si abbinano telefoni e stanze; deve essere rapido e affidabile.
- Rimozione di client non più presenti (comando "dimentica").
- Se un client si disconnette e riconnette, mantiene automaticamente la sua zona (identificazione tramite id Snapcast, che è stabile per dispositivo).

### 3.3 Dispositivi video (Android IP Camera)

- Aggiunta di una telecamera: inserimento manuale di IP (e porta, default 4444) **oppure** scansione automatica della rete locale (probe dell'endpoint `/info.json` sulla porta 4444 su tutti gli host della sottorete, con timeout brevi ed esecuzione in parallelo). La scansione deve essere avviabile dall'utente in qualunque momento ("cerca telecamere").
- Per ogni telecamera: nome, IP, stato (raggiungibile/non raggiungibile), anteprima live, livello batteria e segnale Wi-Fi (letti da `/info.json`), zona assegnata.
- **Funzione "Identifica"**: accende per 2 secondi la torcia del telefono (`/?torch=on` poi `/?torch=off`), così si capisce quale telefono è senza guardare l'anteprima.
- Controlli remoti dall'app, usando i parametri HTTP dell'app telefono: cambio fotocamera (front/back), zoom, esposizione, contrasto, rotazione immagine, torcia, risoluzione, autofocus.
- Credenziali opzionali (username/password) se l'utente le ha impostate sul telefono. Supporto sia http che https con certificato autofirmato (accettare il certificato).
- Una telecamera appartiene a una sola zona.

### 3.4 Libreria suoni

- Importazione di file MP3, WAV, OGG, FLAC (trascinamento nella finestra o selezione file). I file vengono copiati in una cartella dell'app e decodificati/convertiti in PCM al formato del server (44100 Hz, 16 bit, stereo) alla prima importazione, con cache su disco, in modo che la riproduzione sia istantanea.
- Per ogni suono: nome mostrato sul pulsante, colore, categoria (es. "urlo", "ambiente", "botto"), volume relativo, durata, tasto rapido opzionale, flag "sottofondo" (loop).
- Anteprima del suono dal PC (uscita audio del PC, non dei client).
- Riordino dei pulsanti.

### 3.5 Riproduzione audio

- Schermata di produzione: per ogni zona, un riquadro con i pulsanti dei suoni. Premere un pulsante riproduce quel suono **solo nella zona corrispondente**, con latenza dalla pressione all'inizio della riproduzione sui telefoni inferiore a 1,5 s (obiettivo: 0,5–1 s; la parte dovuta al buffer Snapcast è configurabile, default 1000 ms).
- Comportamento per zona:
  - **Sottofondo in loop** (opzionale, un file per zona) sempre attivo a volume basso.
  - Gli effetti si sovrappongono al sottofondo (mix), oppure lo attenuano temporaneamente ("ducking", configurabile con livello di attenuazione e tempi di dissolvenza).
  - Più effetti contemporanei nella stessa zona sono ammessi (mix), con opzione "interrompi il precedente".
  - Pulsante **STOP** per zona (ferma effetti, il sottofondo continua) e **STOP TUTTO** globale.
  - Volume per zona in tempo reale.
- Stesso suono in più zone insieme: selezione multipla di zone o pulsante "tutte le zone" ("botto finale").
- Sequenze (fase 2): elenco di suoni/pause/zone eseguiti in ordine con un solo pulsante.
- Programmazione (fase 2): ripetizione automatica di un suono ogni N secondi in una zona.

### 3.6 Visione video

- Griglia dei video live, una cella per telecamera, raggruppate per zona, con nome della zona sovraimpresso. Layout automatico (1, 2, 4, 6, 9 celle) e possibilità di ingrandire una cella a schermo intero e tornare indietro con un clic.
- Il flusso live deve essere fluido e leggero. Fonte: MJPEG (`/video/m.jpeg`) per la griglia a bassa risoluzione, oppure H.264 (`/video/h264`) decodificato nell'app; lo sviluppatore sceglie in base alla tecnologia, con il vincolo che **ogni telefono venga contattato una sola volta per l'anteprima** (nessuna connessione doppia per la stessa telecamera).
- Indicatore per telecamera: stato connessione, REC attivo, batteria, segnale Wi-Fi.
- Audio live delle telecamere (`/audio`): ascolto opzionale di una telecamera per volta dalle cuffie del PC (utile per capire cosa succede in stanza).

### 3.7 Registrazione video

- Pulsante REC/STOP per singola telecamera, per zona (tutte le telecamere della zona) e globale ("registra tutto").
- Registrazione lato PC tramite **ffmpeg** in bundle: sorgente `/video/h264`, salvataggio in MP4 (o MKV) **senza ricodifica**. Opzione per includere l'audio del telefono da `/audio` (WAV 16 bit mono 44,1 kHz) nel file, accettando una tolleranza di sincronizzazione di qualche decimo di secondo.
- Nome file: `<zona>_<telecamera>_<AAAAMMGG_HHMMSS>.mp4`, cartella configurabile (default `Video\Regia\`).
- Suddivisione automatica dei file ogni N minuti (default 10) per limitare la perdita in caso di crash.
- Controllo dello spazio disco: avviso sotto una soglia, blocco sotto una soglia critica.
- Se la connessione con il telefono cade durante la registrazione, l'app chiude correttamente il file (deve restare leggibile) e riprende a registrare automaticamente su un nuovo file quando il telefono torna raggiungibile, mantenendo lo stato "REC" acceso.
- Elenco delle registrazioni con anteprima, durata, dimensione, apertura della cartella.

### 3.8 Setup guidato

Al primo avvio (e richiamabile in seguito) una procedura guidata in passi:

1. **Controllo ambiente**: server audio disponibile/avviabile, ffmpeg presente, porte libere, regole firewall Windows (crearle chiedendo conferma), indirizzo IP del PC, avviso se il PC è su Wi-Fi anziché cavo.
2. **Avvio del server audio** con un clic; stato visibile.
3. **Istruzioni per i telefoni**, con schermata da mostrare a chi li prepara: link/QR per installare le due app, impostazioni consigliate (batteria senza restrizioni, notifiche, TLS disattivato su IP Camera, risoluzione), indirizzo del server da inserire in Snapdroid (o rilevamento automatico via mDNS, che Snapserver già pubblica). Generare un QR con l'indirizzo IP del server.
4. **Rilevamento dispositivi**: la lista si riempie da sola man mano che i telefoni si collegano; la scansione delle telecamere è avviabile con un pulsante.
5. **Creazione zone e assegnazione**, con le funzioni "Identifica" sempre a portata di mano.
6. **Prova**: per ogni zona, pulsante "test audio" (suono di prova su tutti i client della zona) e "test video".
7. **Riepilogo** con eventuali avvisi (zona senza audio, telecamera senza luce sufficiente, batteria bassa, telefono non in carica).

### 3.9 Salvataggio e profili

- Tutta la configurazione (zone, dispositivi, suoni, impostazioni) in un file di progetto (JSON) salvato automaticamente a ogni modifica, con esportazione/importazione per riutilizzo in un altro evento.
- Ripristino automatico dello stato all'avvio: il server viene riavviato, i client vengono riassegnati alle zone, le telecamere ricollegate.

### 3.10 Monitoraggio e diagnostica

- Pannello di stato sempre visibile: server audio (acceso/spento, numero client), dispositivi persi (evidenziati in rosso con notifica sonora facoltativa sul PC), carico CPU dell'app, spazio disco.
- Log leggibile dall'utente (eventi principali) e log tecnico esportabile per assistenza.
- Pulsante "ricollega tutto" che forza la riconnessione dei client audio (via server) e delle telecamere.

---

## 4. Architettura consigliata

Lo sviluppatore è libero di scegliere linguaggio e framework; quanto segue è indicativo e vincola solo dove indicato con "obbligatorio".

### 4.1 Componenti

```
+----------------------------------------------------------------------+
|  PC Windows 11                                                       |
|                                                                      |
|  +------------------------------------------------------------+      |
|  |  App "Regia" (interfaccia + logica)                        |      |
|  |                                                            |      |
|  |  Motore audio ---- PCM continuo per zona ---> Snapserver   |      |
|  |  Gestione zone/dispositivi <--- JSON-RPC ---> Snapserver   |      |
|  |  Visualizzazione video <--- HTTP ------------ telefoni cam |      |
|  |  Registrazione ---> ffmpeg (processi) <------ telefoni cam |      |
|  +------------------------------------------------------------+      |
|                                                                      |
|  Snapserver (processo gestito dall'app)      ffmpeg.exe (bundle)     |
+----------------------------------------------------------------------+
            |  Wi-Fi locale (porte 1704/1705 TCP, 4444 TCP)  |
   +-----------------+      +-----------------+      +-----------------+
   | Telefono zona A |      | Telefono zona A |      | Telefono zona B |
   | Snapdroid       |      | IP Camera       |      | Snapdroid+Camera|
   | + cassa jack    |      |                 |      | + cassa jack    |
   +-----------------+      +-----------------+      +-----------------+
```

### 4.2 Esecuzione di Snapserver su Windows (decisione prioritaria)

Opzioni, in ordine di preferenza:

1. **Binario nativo Windows compilato dal progetto** (build da sorgente con vcpkg, documentata dal progetto Snapcast in `doc/build.md`). Risultato: un unico eseguibile distribuito insieme all'app, nessuna dipendenza esterna, esperienza utente migliore. Da valutare per prima: se la compilazione riesce e il server è stabile, è la scelta obbligatoria.
2. **WSL2** con Ubuntu e pacchetto `snapserver`, avviato e controllato dall'app (`wsl -d Ubuntu -- snapserver ...`). Funziona (già verificato), ma richiede l'installazione di WSL, `networkingMode=mirrored` nel `.wslconfig` e regole firewall: il setup guidato deve automatizzare questi passi.
3. **Docker Desktop**: sconsigliato per il peso dell'installazione.

In ogni caso il server è un **processo figlio gestito dall'app**: avvio, arresto, riavvio, cattura del log, watchdog che lo riavvia se cade.

### 4.3 Alimentazione audio del server (obbligatorio: flussi continui)

- Un flusso Snapcast per zona, creato/aggiornato dall'app nel file di configurazione del server (`snapserver.conf`, sezione `[stream]`) o, dove disponibile, via RPC (`Stream.AddStream` / `Stream.RemoveStream`, disponibili nelle versioni recenti).
- Sorgente consigliata: **`tcp://`** in modalità server sul lato Snapserver (un port per zona, es. 4953+n), a cui l'app si connette e scrive PCM 44100 Hz / 16 bit / stereo in modo continuo. È multipiattaforma, non ha i problemi delle named pipe e permette all'app di rilevare subito la caduta della connessione.
- Codec: `pcm` come default (unico verificato con Snapdroid su Android recente); `opus` da testare come alternativa a basso consumo di banda; FLAC da evitare.
- Parametri stream: `sampleformat=44100:16:2`, `buffer` configurabile (default 1000 ms; l'utente può scendere a 500 ms se la rete è buona).
- Il **motore di mixaggio** nell'app produce per ogni zona, senza interruzioni, la somma di: sottofondo in loop (se presente), effetti attivi, altrimenti silenzio digitale. Cadenza di scrittura regolare (es. blocchi di 20 ms). Volume di zona applicato nel mix. Dissolvenze di 10–20 ms all'inizio e alla fine di ogni effetto per evitare click.

### 4.4 Controllo di Snapserver

- Protocollo **JSON-RPC** di Snapcast (documentato in `doc/json_rpc_api/control.md`): TCP porta 1705, oppure HTTP/WebSocket porta 1780. Usare il WebSocket per ricevere le notifiche in tempo reale (client connesso/disconnesso, cambio volume).
- Metodi principali: `Server.GetStatus`, `Client.SetName`, `Client.SetVolume`, `Client.SetLatency`, `Group.SetStream`, `Group.SetClients`, `Group.SetMute`, `Server.DeleteClient`.
- Modello: una zona ↔ uno stream ↔ un gruppo Snapcast contenente i client della zona. L'app tiene i tre allineati e ripristina l'allineamento a ogni riconnessione.
- "Identifica" client: si può realizzare mandando il suono di identificazione solo nello stream della zona temporanea, oppure, più semplice, creando al volo uno stream "identify" e spostando il client su quello per 2 secondi.

### 4.5 Video

- Anteprima: consumo di `/video/m.jpeg` (multipart JPEG, semplice da mostrare in qualunque toolkit) a risoluzione bassa/media, **oppure** decodifica di `/video/h264` con un decoder hardware. Una sola connessione per telecamera per l'anteprima; la registrazione è una seconda connessione separata (accettabile: la sorgente H.264 non richiede ricodifica sul telefono).
- Se lo sviluppatore lo ritiene utile, può usare **go2rtc** come componente interno per ricevere e ridistribuire i flussi (supporta MJPEG, H.264 e WebRTC), ma non è obbligatorio.
- Registrazione: `ffmpeg -f h264 -i http://IP:4444/video/h264 -c copy -f segment -segment_time 600 -reset_timestamps 1 file_%03d.mp4` (esempio; con audio, aggiungere `-i http://IP:4444/audio` e mappare le tracce). Un processo per telecamera in registrazione, terminato in modo pulito (invio di `q` su stdin) per garantire file leggibili.

### 4.6 Persistenza e struttura dati (indicativa)

```json
{
  "version": 1,
  "server": { "mode": "native|wsl", "buffer_ms": 1000, "codec": "pcm" },
  "zones": [
    {
      "id": "z1", "name": "Ingresso", "color": "#ff6600", "volume": 0.8,
      "ambient_sound_id": "s1",
      "audio_clients": ["snapcast-client-id-1"],
      "cameras": ["cam-1"],
      "sound_ids": ["s2", "s3", "s4"]
    }
  ],
  "cameras": [
    { "id": "cam-1", "name": "Ingresso porta", "host": "192.168.1.61", "port": 4444,
      "https": false, "user": null, "password": null }
  ],
  "sounds": [
    { "id": "s2", "name": "Urlo", "file": "sounds/urlo.mp3", "gain": 1.0,
      "color": "#cc0000", "hotkey": "F1", "loop": false }
  ],
  "recording": { "folder": "C:/Users/.../Videos/Regia", "segment_minutes": 10, "with_audio": true }
}
```

---

## 5. Interfaccia utente

### 5.1 Schermate

1. **Produzione** (schermata principale durante l'evento): griglia video in alto o a sinistra; sotto/a destra i riquadri delle zone con i pulsanti suoni, volume, STOP; barra di stato in basso. Pulsanti grandi, adatti anche a touchscreen; contrasto elevato per stanza buia (tema scuro obbligatorio).
2. **Dispositivi**: due liste (audio, video) con stato, zona, "Identifica", rinomina, dimentica, scansione telecamere.
3. **Zone**: gestione zone, trascinamento dispositivi, sottofondo, suoni abilitati.
4. **Suoni**: libreria, importazione, anteprima, assegnazione tasti rapidi.
5. **Registrazioni**: elenco file, cartella, impostazioni.
6. **Impostazioni**: server audio, rete, buffer, codec, cartelle, lingua.
7. **Setup guidato** (wizard), richiamabile dal menu.

### 5.2 Principi

- Tutto ciò che serve durante l'evento sta nella schermata Produzione; nessuna finestra di dialogo bloccante durante l'evento.
- Ogni azione distruttiva (elimina zona, dimentica dispositivo, cancella suono) chiede conferma; nessuna conferma per le azioni di riproduzione.
- Feedback immediato: il pulsante del suono si illumina per la durata del suono; il REC lampeggia.
- Tasti rapidi configurabili per suoni e per STOP TUTTO (es. Esc).
- Lingua: italiano; struttura pronta per la traduzione.

---

## 6. Requisiti non funzionali

- **Affidabilità**: l'app deve funzionare per almeno 6 ore consecutive senza riavvio; riconnessione automatica di server, client e telecamere; nessuna perdita di configurazione in caso di crash (salvataggio continuo).
- **Prestazioni**: con 6 telecamere in anteprima e 6 zone audio attive, uso di CPU sotto il 40% su un portatile di fascia media (es. i5 di 10ª generazione), 3 registrazioni contemporanee senza perdita di fotogrammi.
- **Latenza audio**: pressione pulsante → audio dai telefoni entro 1,5 s (obiettivo 1 s).
- **Rete**: solo LAN, nessun servizio cloud, nessun account. Funziona anche senza connessione a internet.
- **Installazione**: un installer o cartella portabile con tutto incluso (app, server audio o script WSL, ffmpeg). Nessun passaggio manuale da terminale per l'utente finale.
- **Sicurezza**: minima, ambiente chiuso; le password delle telecamere vanno comunque salvate cifrate con le API di Windows (DPAPI).
- **Licenze**: Snapcast è GPL-3.0, Android IP Camera MIT, ffmpeg LGPL/GPL a seconda della build: rispettare gli obblighi (in particolare, se si compila Snapserver, tenere separato il processo e distribuire i sorgenti/licenza).

---

## 7. Fasi di consegna

### Fase 1 – MVP (necessaria per l'evento)

- Avvio/arresto server audio; gestione client; zone; assegnazione dispositivi con "Identifica".
- Libreria suoni; riproduzione per zona con flusso continuo, sottofondo in loop, STOP e STOP TUTTO.
- Anteprima video delle telecamere in griglia; REC/STOP per telecamera con ffmpeg (solo video).
- Setup guidato essenziale (controllo ambiente, avvio server, istruzioni telefoni, rilevamento, zone, test).
- Salvataggio/ripristino della configurazione.

### Fase 2 – Miglioramenti

- Registrazione con audio; registra tutto per zona/globale; suddivisione file.
- Sequenze e ripetizioni automatiche; ducking del sottofondo.
- Controlli remoti telecamera (zoom, esposizione, torcia) dalla griglia.
- Ascolto audio live delle telecamere.
- Scansione automatica di rete migliorata, QR per i telefoni.

### Fase 3 – Opzionale

- Trigger da sensori (movimento rilevato nel video, o comando da app sul telefono degli attori).
- Controllo dell'app da un tablet in rete (interfaccia web secondaria).
- Supporto a telecamere RTSP standard (es. TP-Link Tapo) come sorgenti aggiuntive.

---

## 8. Criteri di accettazione (Fase 1)

1. Su un PC Windows 11 pulito, l'installazione e il setup guidato portano ad avere server acceso e primo telefono Snapdroid collegato in meno di 15 minuti, senza usare il terminale.
2. Con 3 telefoni Snapdroid e 3 telefoni IP Camera, la creazione di 3 zone e l'assegnazione di tutti i dispositivi richiede meno di 5 minuti usando "Identifica".
3. Premendo un pulsante suono, l'audio parte nel telefono della zona giusta (e solo lì) entro 1,5 s, per 50 pressioni consecutive senza fallimenti.
4. Con sottofondo attivo in tutte le zone per 60 minuti, nessun client smette di suonare né perde la sincronia; un telefono che viene riavviato torna nella sua zona da solo.
5. La griglia mostra 6 telecamere a 640×480 con almeno 10 fps ciascuna.
6. Registrando 3 telecamere per 10 minuti, i file risultanti si aprono correttamente in VLC e Windows Media Player, senza fotogrammi persi visibili.
7. Chiudendo l'app e riaprendola, la configurazione è identica e tutto si ricollega da solo.
8. Se un telefono perde il Wi-Fi, entro 10 s l'app lo segnala; quando torna, entro 15 s è di nuovo operativo senza intervento.

---

## 9. Materiale di riferimento

- Snapcast: https://github.com/snapcast/snapcast (README, `doc/configuration.md`, `doc/json_rpc_api/control.md`, `doc/build.md`)
- Snapdroid: https://github.com/snapcast/snapdroid
- Android IP Camera: https://github.com/DigitallyRefined/android-ip-camera (README con endpoint e parametri)
- go2rtc (opzionale): https://github.com/AlexxIT/go2rtc
- ffmpeg: https://ffmpeg.org

Configurazione Snapserver usata nei test (funzionante con Snapdroid su Pixel 10):

```
[stream]
source = pipe:///home/utente/pipes/test?name=Test&sampleformat=44100:16:2&codec=pcm
buffer = 1000
```

Comandi ffmpeg verificati:

```
# invio audio a una pipe (da sostituire con la sorgente TCP nell'app)
ffmpeg -re -i suono.mp3 -f s16le -ar 44100 -ac 2 - > pipe

# registrazione video dal telefono senza ricodifica
ffmpeg -f h264 -i http://IP:4444/video/h264 -c copy uscita.mp4
```

---

## 10. Domande aperte per lo sviluppatore

1. Fattibilità e stabilità della compilazione nativa di Snapserver per Windows (§4.2, opzione 1): stimare tempi e rischi prima di scegliere.
2. Scelta tra MJPEG e H.264 per l'anteprima in base al toolkit scelto; verificare il consumo CPU con 6 flussi.
3. Verifica del codec Opus con Snapdroid su Android 15/16: se funziona, ridurrebbe la banda di 10 volte rispetto a PCM.
4. Eventuale uso di go2rtc come componente interno per semplificare la parte video.
5. Stima di massima per Fase 1 e Fase 2.

---

*Fine documento.*
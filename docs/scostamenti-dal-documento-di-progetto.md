# Scostamenti dal documento di progetto

Cose che il documento di progetto v1.0 dice, e che il lavoro di analisi ha mostrato essere
sbagliate, irraggiungibili o superate. Da riportare nella v1.1.

**Il documento parla di un PC Windows, Regia gira anche su Linux.** Dal 10 settembre 2026 il
server audio può stare su una distro WSL (Windows) o sulla macchina stessa (Linux): la scelta e
il perché stanno nell'ADR 0011. Tre voci qui sotto erano scritte come assolute e sono invece
**proprietà di Windows** — la riga 4.2, la riga 3.8.3 e il criterio §8.1. Sono state riscritte
per dire quale metà vale dove. Nessuna di esse è caduta: su Windows valgono parola per parola, e
Windows resta il bersaglio del documento. Ciò che cambia è che adesso esiste una strada in cui
alcuni di quegli ostacoli non ci sono, e il committente ha diritto di saperlo prima di decidere
su quale macchina si fa la casa.

## Errori di fatto

| § | Dice | In realtà |
|---|---|---|
| 3.6, 4.5 | endpoint MJPEG `/video/m.jpeg` | è **`/video/mjpeg`** |
| 3.3, 3.7 | la registrazione lato telefono è da evitare perché ricodifica | quella che ricodifica è la registrazione dal **pannello web** (`MediaRecorder`). L'app espone anche `/record/start`, `/record/stop`, `/record/status`, `/files.json`, `/files/<nome>`, che scrivono MP4 in locale senza ricodifica. È stata comunque scartata, ma per altri motivi — vedi ADR 0009 |
| 4.2 opz. 1 | "binario nativo Windows compilato dal progetto… da valutare per prima" | **chiusa, ma solo per Windows.** Il `CMakeLists.txt` definisce `BUILD_SERVER` `if(NOT WIN32)`, con il commento "no Windows server for now", e la CI upstream compila su Windows soltanto il client: lì compilarlo vorrebbe dire portare il progetto a una piattaforma che upstream non supporta, e mantenerlo a ogni aggiornamento. **La stessa riga, letta al contrario, dice che fuori da Windows il server si compila e gira nativo** — ed è esattamente quello che Regia fa su Linux (ADR 0011). Quindi non «impossibile»: impossibile su Windows. Vedi ADR 0002 e la sua correzione |
| 3.8.3 | "rilevamento automatico via mDNS, che Snapserver già pubblica" | **su Windows non esiste**: avahi/Bonjour stanno dentro `if(NOT WIN32 AND NOT ANDROID)`. Su Linux **ci sarebbe** (`BUILD_WITH_AVAHI` è `ON` di default), e Regia lo tiene spento lo stesso — per scelta, non per impossibilità: una scoperta che funziona su metà delle macchine è peggio di una che non funziona mai (chi impara la procedura su un PC Linux si troverebbe il passo obbligatorio davanti al PC Windows della casa, con i visitatori dentro), e `mdns_enabled = true` pretende un `avahi-daemon` che Regia non installa e non verifica. **L'IP inserito a mano o via QR resta l'unica strada**, non un ripiego. Vedi la correzione dell'ADR 0002 |
| 9 | configurazione di test con `buffer = 2000` | corretta e adottata, ma **incompatibile con il criterio §8.3** come è scritto oggi |

## Criteri di accettazione da riscrivere

- **§8.1** — "PC Windows 11 pulito → server acceso in meno di 15 minuti, senza terminale".
  **Su Windows resta non raggiungibile**, e per la ragione di sempre: WSL2 richiede Virtual
  Machine Platform, la virtualizzazione abilitata da BIOS e un riavvio. Diventa: *installazione
  assistita con un riavvio, poi 15 minuti*.
  Il criterio è scritto su Windows, ma adesso c'è un'altra strada e va scritta accanto invece che
  lasciata implicita. **Su Linux i tre ostacoli non ci sono**: snapserver è un pacchetto, non
  serve abilitare niente nell'hypervisor, non si passa dal BIOS e non si riavvia. Resta però il
  terminale — `sudo apt install snapserver` — perché **Regia non spedisce nessun pacchetto che
  possa tirarsi dietro snapserver da solo**: i bersagli Linux sono AppImage e `tar.gz`, e nessuno
  dei due dichiara dipendenze. Il `.deb`, che sarebbe l'unico formato capace di farlo, è escluso
  apposta — e comunque la dipendenza installerebbe la versione sbagliata su ogni Ubuntu fino alla
  25.10 compresa, come si legge qui sotto. E c'è una trappola da mettere nelle istruzioni
  prima e non dopo: `apt install snapserver` su Ubuntu 24.04 dà la **0.27.0**, che Regia rifiuta
  di avviare, perché sotto la 0.33 la sezione `[tcp]` non si chiamava ancora `[tcp-control]` e un
  server così partirebbe sulle porte sbagliate senza dire niente (ADR 0011). Per Linux diventa
  quindi: *15 minuti senza riavvio e senza BIOS, con un comando di installazione e la versione di
  snapserver dichiarata esplicitamente*.
- **§8.3** — "audio entro 1,5 s". Con `buffer = 2000` è impossibile per costruzione. Diventa:
  *l'audio parte entro `buffer` + 200 ms, in modo deterministico e ripetibile, per 50 pressioni
  consecutive*. Ciò che conta è la costanza, non la brevità.
- **§6, latenza audio** — stessa cosa: "entro 1,5 s (obiettivo 1 s)" va allineato al buffer scelto.
- **§8.5** — "6 telecamere a 640×480 con almeno 10 fps". Da riformulare su H.264 invece che su
  MJPEG, e con il vincolo esplicito di **una sola connessione per Telecamera in totale**,
  anteprima e registrazione comprese.

## Vincoli che il documento non nomina

- **La banda è il collo di bottiglia, non la CPU.** 8 Altoparlanti in PCM stereo sono 11,3 Mbit/s
  continui anche a casa vuota, più 6–12 Mbit/s di video: 12–23 Mbit/s su 14 client Wi-Fi. Il §6
  si preoccupa della CPU, che non è in difficoltà. Il setup guidato deve pretendere 5 GHz e il PC
  via cavo.
- **Il file di progetto va scritto in modo atomico** (file temporaneo + rename). Il §3.9 chiede
  salvataggio a ogni modifica e il §6 chiede nessuna perdita in caso di crash: insieme, escludono
  la scrittura in place.
- **Obblighi GPL-3.0**: distribuendo snapserver dentro l'installer serve la licenza e l'offerta
  scritta dei sorgenti. Il server resta un processo separato, quindi non contamina Regia.
  Oggi nessuno dei pacchetti — né i due Windows né i due Linux — si porta dentro snapserver:
  l'obbligo non è cancellato, è **non innescato**, e per una scelta scritta e non per
  un'omissione. Si riattacca il giorno in cui si decide di spedirlo per togliere di mezzo il
  passo manuale del §8.1: le due cose vanno decise insieme, perché la comodità
  dell'installazione si paga in obblighi di licenza. Vedi la correzione dell'ADR 0003.

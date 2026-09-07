# Scostamenti dal documento di progetto

Cose che il documento di progetto v1.0 dice, e che il lavoro di analisi ha mostrato essere
sbagliate, irraggiungibili o superate. Da riportare nella v1.1.

## Errori di fatto

| § | Dice | In realtà |
|---|---|---|
| 3.6, 4.5 | endpoint MJPEG `/video/m.jpeg` | è **`/video/mjpeg`** |
| 3.3, 3.7 | la registrazione lato telefono è da evitare perché ricodifica | quella che ricodifica è la registrazione dal **pannello web** (`MediaRecorder`). L'app espone anche `/record/start`, `/record/stop`, `/record/status`, `/files.json`, `/files/<nome>`, che scrivono MP4 in locale senza ricodifica. È stata comunque scartata, ma per altri motivi — vedi ADR 0004 |
| 4.2 opz. 1 | "binario nativo Windows compilato dal progetto… da valutare per prima" | **impossibile senza portare il progetto**: il `CMakeLists.txt` definisce `BUILD_SERVER` solo `if(NOT WIN32)`, con il commento "no Windows server for now". La CI upstream compila su Windows solo il client. Vedi ADR 0002 |
| 3.8.3 | "rilevamento automatico via mDNS, che Snapserver già pubblica" | avahi/Bonjour sono compilati solo `if(NOT WIN32 AND NOT ANDROID)`, e da WSL2 in `networkingMode=mirrored` il multicast verso la LAN non è affidabile. **L'IP inserito a mano o via QR è l'unica strada**, non un ripiego |
| 9 | configurazione di test con `buffer = 2000` | corretta e adottata, ma **incompatibile con il criterio §8.3** come è scritto oggi |

## Criteri di accettazione da riscrivere

- **§8.1** — "PC Windows 11 pulito → server acceso in meno di 15 minuti, senza terminale".
  Non raggiungibile: WSL2 richiede Virtual Machine Platform, un riavvio e la virtualizzazione
  abilitata da BIOS. Diventa: *installazione assistita con un riavvio, poi 15 minuti*.
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

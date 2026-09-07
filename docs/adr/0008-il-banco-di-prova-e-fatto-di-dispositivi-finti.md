# Il banco di prova è fatto di dispositivi finti

Sono disponibili **un telefono** durante lo sviluppo e **due** per le prove pre-evento. I criteri
di accettazione del §8 ne chiedono sei o più. Quindi il collaudo quotidiano non usa telefoni.

**Altoparlanti finti**: `snapclient_win64.zip` è un asset ufficiale della release Snapcast e gira
sullo stesso PC. Più istanze con `--hostID` diverso sono N Altoparlanti indipendenti, sufficienti
per collaudare la riconciliazione, la gestione dei gruppi, il mute/unmute di Identifica, la
rigenerazione della configurazione con riavvio, la riassegnazione dopo una disconnessione, e il
soak da 60 minuti del §8.4.

**Telecamere finte**: un servizio locale che espone `/video/h264` leggendo un file H.264 in loop e
un `/info.json` plausibile, con la possibilità di simulare una caduta. Basta per la griglia a 6
celle, per il riavvio della registrazione dopo una caduta, e per il conteggio delle connessioni.

Questo è anche il motivo per cui il motore è headless e pilotabile via WebSocket: le 50 pressioni
consecutive del §8.3 sono uno script, non un dito.

## Cosa i finti non possono dire

Il fallimento di FLAC nei test sul campo era **silenzioso** ed era specifico di Snapdroid su
Android recente, non di Snapcast: `snapclient` su Windows non lo avrebbe mai riprodotto. Quindi
restano al telefono vero, e vanno misurate presto perché una di queste cancella un problema:

- **Opus con Snapdroid** — se funziona, la banda audio crolla di dieci volte e il problema Wi-Fi
  del §6 sparisce.
- **Mono sul cavo jack** — se il canale singolo arriva alla cassa, la banda si dimezza comunque.
- **Latenza reale su Wi-Fi**, per decidere se `buffer` può scendere da 2000.
- **Se la Telecamera regge `/video/h264` mentre fa altro**, e il comportamento reale quando cade
  il Wi-Fi.
- **Risparmio energetico**: che i telefoni restino vivi per sei ore, che è il §6 e nessun client
  finto lo mette alla prova.

Corollario per il codice: codec, sampleformat e buffer sono **impostazioni**, non costanti. Le
misure arriveranno dopo che il grosso sarà già costruito.

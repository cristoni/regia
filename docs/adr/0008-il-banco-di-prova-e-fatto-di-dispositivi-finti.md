# Il banco di prova è fatto di dispositivi finti

Sono disponibili **un telefono** durante lo sviluppo e **due** per le prove pre-evento. I criteri
di accettazione del §8 ne chiedono sei o più. Quindi il collaudo quotidiano non usa telefoni.

**Altoparlanti finti**: `snapclient_win64.zip` è un asset ufficiale della release Snapcast e gira
sullo stesso PC. Più istanze con `--hostID` diverso sono N Altoparlanti indipendenti, sufficienti
per collaudare la riconciliazione, la gestione dei gruppi, il mute/unmute di Identifica, la
rigenerazione della configurazione con riavvio, la riassegnazione dopo una disconnessione, e il
soak da 60 minuti del §8.4. `--player file:filename=/dev/null` consuma i chunk al ritmo giusto
senza toccare una scheda audio.

### Correzione: girano dentro la distro, non su Windows

Questo ADR diceva `snapclient_win64.zip`, che e un asset ufficiale e gira sullo stesso PC. **Non
funziona**, ed e stato scoperto misurando: il client Windows contro un snapserver Linux riporta

    diff to server [ms]: -1.78885e+12

cioe uno scarto d'orologio di **meno cinquantasei anni** -- l'ordine di grandezza esatto
dell'epoch Unix. Da li in poi scarta ogni chunk come fuori tempo e ripete "No chunks available"
una volta al secondo, per sempre. Lo stesso client compilato per **Linux**, contro lo **stesso**
server, riporta `diff to server: 0.008 ms` e non perde un chunk.

Quindi gli Altoparlanti finti girano dentro la distro WSL (`banco/altoparlanti-finti.ts`), dove si
sincronizzano a 7-14 microsecondi. Il `.exe` per Windows resta scaricato per diagnosticare a mano.

**Non tocca il prodotto**: Snapdroid usa un client Android, che e la stessa famiglia del client
Linux. Ma va saputo: un PC Windows non puo fare da Altoparlante aggiuntivo.

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

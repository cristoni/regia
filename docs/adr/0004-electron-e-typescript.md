# Regia è un'applicazione Electron in TypeScript

## Il percorso video decide, non il linguaggio

La preoccupazione legittima era che una soluzione JavaScript non reggesse il video, avendo
visto una registrazione "inguardabile" nei test. Quella però era la registrazione dal pannello
web dell'app telefono, che cattura lo stream renderizzato e lo **ricodifica** con `MediaRecorder`
sul telefono (§2.2 del documento di progetto). Quella ricodifica non esiste in nessuna delle
architetture prese in considerazione.

Il percorso video di Regia, che è anche il più performante possibile in qualunque stack:

```
/video/h264  →  una sola connessione  →  ┬→ WebCodecs VideoDecoder (hardware) → canvas
                                          └→ ffmpeg -c copy → file
```

`/video/h264` è H.264 Annex-B grezzo. Si apre **una connessione sola per Telecamera** e si
sdoppia il flusso di byte: il decoder hardware della GPU per l'anteprima, gli stessi byte su
disco senza mai decodificarli per la registrazione. Rispetto a MJPEG è circa un decimo della
banda — e con 6 Telecamere più gli Altoparlanti che ricevono PCM continuo, il collo di
bottiglia è la rete Wi-Fi, non la CPU. Risolve anche la tensione del §4.5: una connessione per
Telecamera **in totale**, non una per l'anteprima più una per la registrazione.

Questo percorso è identico in Electron e in Tauri, perché entrambi sono Chromium. Non è quindi
un argomento a favore di nessuno dei due.

## Perché Electron e non Rust o .NET

Rust darebbe un mixer senza garbage collector e un installer molto più piccolo; .NET darebbe
DPAPI in libreria standard. Ma il mixer è ~2 MB/s di somme di interi a 16 bit: tutti e tre lo
fanno con margine, e la pausa del GC si annulla scrivendo qualche centinaio di millisecondi in
anticipo nel socket. Il rischio di questo progetto non è nei cicli di CPU, è nei dettagli di
integrazione — WSL, riconciliazione con Snapcast, telefoni che spariscono, ffmpeg — e lì conta
la familiarità con lo stack.

.NET perde in particolare sul pezzo più vincolato dal documento: senza WebCodecs, la
decodifica H.264 hardware va fatta con Media Foundation e la griglia disegnata a mano.

## Conseguenze

- Il mixer sta in un `worker_thread`, mai sul thread che ridisegna sei anteprime video.
  **Verificato, e non era teoria**: con mixer e scrittori sul thread principale, sotto un carico
  modesto, lo scrittore restava indietro di oltre mezzo secondo e rinunciava a pezzi di Flusso.
  Spostati nel thread audio e bloccando il thread principale per 28,4 secondi su 40, i Flussi
  hanno perso 0 ms. Il confine non trasporta campioni: i Suoni li legge il thread audio dalla
  cache su disco, cosi un Sottofondo da 31 MB non viene ne copiato ne duplicato.
- I buffer PCM sono preallocati e riusati: nessuna allocazione nel ciclo di mixaggio.
- Le password delle Telecamere richiedono un modulo nativo per DPAPI (§6).
- MJPEG in un `<img>` resta come ripiego se WebCodecs dà problemi su qualche GPU: costa una
  riga, ma consuma dieci volte la banda.

## Precisazione dopo la scelta del motore headless

Questo ADR è stato scritto assumendo IPC fra main e renderer di Electron. La decisione
successiva — motore headless che serve l'interfaccia via HTTP/WebSocket — cambia dove passano i
byte, e va detto con precisione perché tocca un vincolo che abbiamo promesso.

**Lo sdoppiamento vive nel motore, il decoder vive nell'interfaccia.** Il motore apre l'unica
connessione verso la Telecamera, e distribuisce gli stessi byte a tre destinazioni possibili:
ffmpeg (se si sta registrando), e ogni interfaccia collegata via WebSocket, che li dà al proprio
`VideoDecoder`. Con due interfacce aperte — la finestra di Electron e il tablet della Fase 3 — il
ventaglio si allarga a due, **ma la connessione verso il telefono resta una sola**. È questo che
tiene in piedi il vincolo "una connessione per Telecamera in totale" del §4.5, ed è il motivo per
cui il fetch non può stare nell'interfaccia.

**Ne consegue che il ripiego MJPEG non è più una riga.** Un `<img src="http://ip:4444/video/mjpeg">`
nel renderer aprirebbe una **seconda connessione diretta** dall'interfaccia al telefono, scavalcando
lo sdoppiamento — e con un tablet collegato diventerebbero tre. Se serve MJPEG, va preso dal motore
e ridistribuito come tutto il resto. Nessuna interfaccia di Regia contatta mai un telefono
direttamente.

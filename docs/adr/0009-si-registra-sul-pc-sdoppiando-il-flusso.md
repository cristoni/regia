# Si registra sul PC, sdoppiando il flusso gia aperto

Regia apre **una sola** connessione a `/video/h264` per Telecamera e manda gli stessi byte a due
destinazioni: il decoder WebCodecs delle interfacce collegate, e -- quando si registra -- lo
stdin di un ffmpeg che li impacchetta in MP4 con `-c copy`. **ffmpeg non contatta mai il
telefono**: e questo che tiene in piedi il vincolo del §4.5, una connessione per Telecamera *in
totale* e non una per l'anteprima piu una per la registrazione.

Se il Wi-Fi cade, si chiude lo stdin in modo ordinato -- il file resta leggibile -- e si apre un
file nuovo quando il telefono torna, che e alla lettera il §3.7.

## L'alternativa vera, e perche non e stata scelta

L'app del telefono **registra nativamente**: `/record/start`, `/record/stop`, `/record/status`,
`/files.json`, `/files/<nome>`, MP4 scritto in locale senza ricodifica. Il §2.2 del documento di
progetto l'aveva scartata confondendola con la registrazione dal **pannello web**, che e un'altra
cosa: quella cattura lo stream renderizzato e lo **ricodifica** con `MediaRecorder`.

Il suo vantaggio reale, e non banale: **il telefono continua a registrare anche mentre il Wi-Fi e
caduto**, quindi nel girato non resta un buco. In cambio si riempie la memoria del telefono, a fine
serata vanno scaricati gigabyte da sei telefoni via Wi-Fi, non si controlla lo spazio da Regia, e
resta da verificare sul campo se il telefono regga registrazione e streaming insieme.

Ha pesato che con lo sdoppiamento la registrazione lato PC costa quasi nulla -- i byte sono gia in
casa -- mentre l'unico vantaggio della registrazione sul telefono e la continuita durante una
caduta di rete, che per un girato di reazioni dei visitatori e fastidiosa ma non fatale.

## Vincoli da rispettare, misurati

- **Il binario di ffmpeg deve essere quello in bundle, non quello del PATH.** Su questa macchina
  l'`ffmpeg` del PATH e uno shim Chocolatey da 26 KB che lancia il vero ffmpeg come figlio:
  `child.kill()` uccide lo shim e lascia il vero ffmpeg orfano.
- **Chiusura con `stdin.end()`, mai `kill()`**, o il `moov` non viene scritto e il file non si apre.
- **Niente `-r` sull'input**: forza il CFR e sbaglia la durata quando la sorgente devia dal
  nominale (verificato: 20 secondi reali diventati un file da 8).
- La Telecamera emette un fotogramma chiave **ogni secondo, non configurabile**: una registrazione
  che parte adesso comincia entro un secondo, e un'interfaccia che si collega adesso vede nero fino
  al primo IDR. Tenere in cache l'ultimo IDR con il suo SPS/PPS fa partire subito le successive.

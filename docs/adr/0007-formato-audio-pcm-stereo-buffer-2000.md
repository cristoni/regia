# PCM stereo 44.1 kHz, buffer 2000 ms

Gli stream sono `sampleformat=44100:16:2`, `codec=pcm`, `buffer=2000`. È esattamente la
combinazione già verificata sul campo con Snapdroid su Pixel 10, incluso il buffer.

## Perché 2000 ms e non 1000

Il `buffer` di Snapcast è la profondità della pipeline, ed è anche ciò che assorbe le esitazioni
del Wi-Fi: più è alto, più il sistema tollera una rete carica senza che i client vadano in
underrun. Si sceglie l'affidabilità del §6 (sei ore senza interruzioni) sopra la latenza.

**Conseguenza: il criterio §8.3 del documento di progetto non è più raggiungibile e va riscritto.**
"Audio entro 1,5 s" diventa: *l'audio parte entro `latenzaAttesaMs()` piu 200 ms di tolleranza,
in modo deterministico e ripetibile, per 50 pressioni consecutive*. Il criterio si scrive contro
quella funzione e non contro un numero: `latenzaAttesaMs()` vale `buffer + anticipo`, e l'anticipo
non e ancora stato misurato. Il valore che conta non è quanto è breve il ritardo,
è quanto è **costante**: un ritardo di due secondi sempre uguale è utilizzabile, uno da 800 ms
che ogni tanto diventa 3 s non lo è.

`buffer` resta un'impostazione: se le misure sul campo mostrano che 1000 ms regge, si abbassa.

## La banda, che è il vero collo di bottiglia

Con 8 Altoparlanti, PCM stereo significa **11,3 Mbit/s continui**, anche quando nella casa non
succede niente, più 6–12 Mbit/s di video H.264: 12–23 Mbit/s su 14 client Wi-Fi. Sta in piedi su
5 GHz, è al limite su 2,4 GHz condivisi. Il setup guidato deve dirlo.

Due ottimizzazioni restano aperte, da **misurare** con i telefoni veri e non da assumere:

- **Opus** (§10 domanda 3): dieci volte meno banda. Non provato con Snapdroid su Android recente,
  e su quella stessa combinazione FLAC ha già fallito **silenziosamente** — nessun audio, nessun
  errore. Va provato, non adottato per fede.
- **Mono** (`44100:16:1`): dimezza la banda, e per un urlo da una cassa amplificata in una stanza
  buia lo stereo non serve. Rischio da verificare: il telefono è collegato alla cassa con un jack,
  e un flusso mono su un cavo stereo può finire su un canale solo.

---

## Correzioni, dopo la ricerca tecnica

**L'anticipo di scrittura si somma al `buffer`.** Non era stato collegato da nessuno. Snapserver
data i blocchi quando li **legge**, quindi l'audio fermo nella coda della socket ritarda il proprio
timestamp: la latenza dal pulsante al suono e `buffer + anticipo`. Con 2000 + 200 sono 2,2 s; con
un anticipo da 1 s diventano 3,2 s e il criterio §8.3, gia riscritto una volta, salterebbe di nuovo.

**L'anticipo e quindi un parametro di latenza, non solo di robustezza.** Va tenuto al minimo che
regge, e il minimo si misura: sweep a 50 / 100 / 200 / 400 / 1000 ms, dieci minuti ciascuno, con
tutte e tredici le socket, guardando la **distribuzione** delle magnitudini di risincronizzazione.
Lo snapclient fa una risincronizzazione dura solo sopra 500 ms di scarto: l'obiettivo non e zero
risincronizzazioni, e nessuna abbastanza grande.

**`idle_threshold` va portato a 2000 ms.** Vale 100 di default, e il controllo di stato scatta a
`idle_threshold + chunk_ms` = 120 ms: e da li che nasce il lampeggio `idle ⇄ playing` del §2.2.
Alzarlo cancella meta del problema gratis, e lascia che l'anticipo si occupi solo dell'altra meta.

**`buffer` e una impostazione globale.** Non esiste per sorgente: sta in `[stream]` e vale per
tutte le Zone insieme. Non si puo dare piu buffer a una stanza lontana — per quella c'e
`Client.SetLatency`, limitato a `[-10000, buffer]`, quindi con `buffer=2000` l'intervallo utile e
asimmetrico.

**Ogni scrittura deve essere multipla di 4 byte.** Un frame stereo a 16 bit sono 4 byte; una
scrittura disallineata inverte L e R **per sempre**, e snapserver non ha modo di riallinearsi fra
una lettura e l'altra. E il classico residuo di una conversione da float: va messo come assertion.

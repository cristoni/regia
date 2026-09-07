# PCM stereo 44.1 kHz, buffer 2000 ms

Gli stream sono `sampleformat=44100:16:2`, `codec=pcm`, `buffer=2000`. È esattamente la
combinazione già verificata sul campo con Snapdroid su Pixel 10, incluso il buffer.

## Perché 2000 ms e non 1000

Il `buffer` di Snapcast è la profondità della pipeline, ed è anche ciò che assorbe le esitazioni
del Wi-Fi: più è alto, più il sistema tollera una rete carica senza che i client vadano in
underrun. Si sceglie l'affidabilità del §6 (sei ore senza interruzioni) sopra la latenza.

**Conseguenza: il criterio §8.3 del documento di progetto non è più raggiungibile e va riscritto.**
"Audio entro 1,5 s" diventa: *l'audio parte entro `buffer` + 200 ms, in modo deterministico e
ripetibile, per 50 pressioni consecutive*. Il valore che conta non è quanto è breve il ritardo,
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

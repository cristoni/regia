# Regia fissa la risoluzione della Telecamera durante la registrazione

Fino a oggi Regia **non toccava** la risoluzione: `preparaTelecamera` applicava un preset di due
voci — streaming acceso, torcia spenta — e un commento in `gestore.ts` diceva a chiare lettere che
risoluzione, zoom e rotazione «non stanno nel preset perché non stanno nel dominio, e Regia non li
tocca mai». La prova reale del 13 settembre 2026 ha mostrato perché quel confine non regge alla
registrazione: con `streamRes: "auto"` il telefono **cambia geometria a metà stream**, e una
registrazione `-c:v copy` che cambia dimensione a metà si blocca nei lettori rigidi.

## La decisione

All'accensione del REC, Regia invia `/?resolution=1280x720` alla Telecamera, via il percorso
`comanda` già esistente, fissando una geometria concreta per tutta la ripresa. È lo stesso gesto
del preset — «rimettere la Telecamera nello stato che Regia si aspetta» — esteso a una terza voce,
attiva **solo mentre si registra**.

La risoluzione **non entra nel dominio**: niente campo su `zTelecamera`, niente in `progetto.json`,
niente `VERSIONE_PROGETTO` da alzare. È uno stato che Regia impone al telefono a runtime, non un
fatto del progetto che viaggia fra le macchine.

## Il punto che vale l'ADR: perché `auto` rompe `-c:v copy`, e perché la cura è un valore concreto

Il video non si ricodifica mai ([ADR 0009](0009-si-registra-sul-pc-sdoppiando-il-flusso.md)):
ffmpeg copia i byte H.264 in un MP4 con un solo `avcC`, scritto dal primo fotogramma chiave. Con
`streamRes: "auto"` la `ResolutionStrategy` della camera sceglie una risoluzione nativa vicina al
target e **la può cambiare a ogni rebind** — e i rebind capitano da soli, guidati dalla luce
attraverso l'auto-fps. Misurato: `.7` alterna 1024×576 e 720×480, `.16` alterna 960×720 e 800×608,
in una manciata di decine di secondi. Quando la geometria cambia, i fotogrammi nuovi non stanno più
nell'`avcC` dichiarato: ffmpeg-decodificatore reinizializza e li legge, ma i lettori rigidi (Windows
Media Player, Foto di Windows, le pipeline hardware) onorano la dimensione del contenitore e si
bloccano sul primo fotogramma. È esattamente il file «un solo frame» del committente.

La cura è togliere l'adattività, e per farlo serve un valore **concreto**: `?resolution=WxH` scrive
la preferenza `stream_res` fissa, mentre le etichette `low|medium|high` toccano solo il *target* di
`auto` e lasciano vivo l'adattamento (letto in `StreamingService.kt`). Con un `WxH` la geometria
resta una sola per tutta la ripresa (misurato). 1280×720 perché è **nativo** sull'obiettivo attivo
del telefono nuovo, è standard ovunque, e dà più qualità del vecchio 800×600 di ripiego.

Non basta da solo: lo switch è intermittente, e su qualche obiettivo un valore non nativo verrebbe
comunque riavvicinato. Perciò resta necessaria la **rete di sicurezza** — `MuxTs` rileva un cambio
di geometria e taglia un segmento nuovo, riusando il ciclo di ripresa — che senza questa decisione
sarebbe stata l'unica difesa, e con essa diventa il raro caso di scampo invece della regola.

## Precedenza e ripristino

Durante il REC Regia **vince** su un `auto` impostato a mano dall'operatore sul telefono: una
ripresa ha bisogno di una geometria stabile, e la stabilità batte la preferenza adattiva. Lo scrive
nel Diario. A fine REC Regia **non ripristina** `auto`, coerente col resto del preset, che non
ripristina niente: il telefono resta come Regia l'ha lasciato, e fuori dal REC l'operatore ne è di
nuovo padrone.

## Alternative scartate

**Un campo `risoluzione` su `zTelecamera`.** Darebbe una scelta per Telecamera, ma costa una
migrazione del progetto, una voce d'interfaccia e uno schema più largo, per un bisogno che nessuno
ha chiesto: il committente vuole registrazioni non rotte, non un pannello risoluzioni. E porta la
risoluzione nel dominio, cioè in una cosa che viaggia fra Windows e Linux, quando è un dettaglio del
telefono. Se un giorno servirà scegliere per Telecamera, entrerà allora — nel dominio e in questo
punto insieme, come già dice il commento storico.

**Non fissare niente e affidarsi solo al taglio-segmento.** Lascerebbe `auto` e spezzerebbe ogni
ripresa in molti file a ogni cambio di scena: il taglio, che deve essere l'eccezione, diventerebbe
la regola. Fissare la risoluzione rende il taglio raro; toglierlo del tutto no.

**Ri-ancorare lo zero dell'audio al collegamento di ffmpeg** (per il silenzio in testa, guasto
distinto ma emerso nella stessa prova). Eliminerebbe il silenzio ma sfaserebbe l'audio di ~5 s: è
stata scartata a favore dell'accorciamento del sondaggio di ffmpeg. Non è oggetto di questo ADR —
sta nei fatti verificati — ma va nominata perché è la trappola vicina.

## Conseguenze

- Il commento in `gestore.ts` che diceva «Regia non tocca la risoluzione» va corretto: ora la tocca,
  ma solo a runtime e solo durante il REC.
- 1280×720 è confermato nativo sull'obiettivo attivo di `.7`; **resta da verificare** che lo sia
  sull'obiettivo attivo di tutti i telefoni del parco. È quasi universale, ma se un obiettivo non lo
  avesse, la `ResolutionStrategy` sceglierebbe la nativa più vicina — e lì rientra la rete di
  sicurezza del taglio-segmento.
- Un guasto separato e più grosso resta aperto e non è chiuso da questa decisione: **l'audio
  robotico in doppia registrazione**, che è indotto dal carico sul thread principale e non dallo
  switch di risoluzione (misurato). Vedi `docs/fatti-verificati.md` e il piano in
  `.scratch/registrazioni-difettose/`.

## Cosa è stato misurato

Il 13 settembre 2026, contro i due telefoni veri, riproducendo la pipeline di registrazione con i
moduli veri: lo switch di geometria ad `auto` su entrambi i telefoni; la tenuta a una sola geometria
con `?resolution=WxH`; il congelamento dipendente dal lettore su uno switch iniettato (ffmpeg
decodifica pulito, l'`avcC` unico blocca i lettori rigidi); il contratto del parametro letto in
`StreamingService.kt`. Le righe stanno in [`docs/fatti-verificati.md`](../fatti-verificati.md).

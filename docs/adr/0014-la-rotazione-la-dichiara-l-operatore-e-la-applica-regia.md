# La rotazione la dichiara l'Operatore, e la applica Regia

L'[ADR 0013](0013-l-orientamento-di-una-telecamera-si-legge-dal-video.md) voleva *accorgersi* di
come fosse girata una Telecamera. La correzione in fondo a quel file racconta com'è finita: sul
telefono della casa l'orientamento **non esce dal telefono in nessuna forma** — né dalla
geometria del fotogramma, né da `/info.json`, né dallo scatto — perché l'app impagina l'immagine
verticale dentro un fotogramma orizzontale fisso, fra due bande nere. Non è un problema di
implementazione: l'informazione non c'è.

Ma la domanda dell'Operatore resta, e nella casa è una domanda facile: i telefoni si montano il
pomeriggio e restano dove sono per tutta la serata. Chi li monta **sa** come li ha messi.

## La decisione

Ogni Telecamera ha una `rotazione` — 0, 90, 180 o 270 gradi **orari** — che l'Operatore dichiara
con un pulsante, sulla cella dell'anteprima e nella schermata Dispositivi. Ogni clic è un quarto
di giro. Regia la applica in due posti, e **non la manda al telefono**:

- **nell'anteprima**, girando il disegno sulla `<canvas>` (`decodificatore.ts`): la tela scambia i
  lati e il contesto ruota. Il `VideoDecoder` non se ne accorge, quindi cambiare rotazione non
  costa un fotogramma chiave e la cella non lampeggia;
- **nella registrazione**, scrivendo la **matrice di visualizzazione** nell'MP4
  (`-display_rotation` sull'ingresso di ffmpeg): i lettori la onorano e mostrano il video dritto.

La rotazione vive nel **progetto** (`zTelecamera`), perché è un fatto dell'installazione e non
dello stato di runtime: deve sopravvivere alla chiusura di Regia e viaggiare col progetto
esportato. Ha un default a 0, e per questo **non alza `VERSIONE_PROGETTO`**: un progetto scritto
prima si apre senza migrazioni, con le Telecamere dritte, che è come si comportavano.

## Il punto che vale l'ADR: ruotare senza ricodificare

L'[ADR 0009](0009-si-registra-sul-pc-sdoppiando-il-flusso.md) dice che il video non si ricodifica
mai, e non è una preferenza estetica: con due registrazioni in corso il thread principale è già
il collo di bottiglia, ed è da lì che nasce l'audio robotico ancora aperto nei fatti verificati.
Un filtro `transpose` costerebbe una decodifica e una ricodifica per Telecamera, esattamente dove
non c'è margine.

La matrice di visualizzazione risolve il problema a costo zero: è un campo di 36 byte nell'atomo
`tkhd`, i fotogrammi restano gli stessi byte usciti dal telefono, e `-c:v copy` non si tocca.
Misurato il 19 settembre 2026 con l'ffmpeg in `vendor/`: `-display_rotation:v:0 <gradi>` scrive la
matrice, mentre `-metadata:s:v:0 rotate=<gradi>` — la strada vecchia che si trova nei forum —
viene **ignorato in silenzio** e produce una matrice identità. È un'opzione dell'**ingresso**,
quindi va prima di `-i`.

Un dettaglio che si sbaglia una volta sola: `-display_rotation` gira in senso **antiorario**,
mentre `rotazione` è in gradi orari. Il segno si inverte, e la verifica non è stata di lettura ma
di occhio — due file costruiti dai fotogrammi veri del telefono, uno per senso, e si è guardato
quale usciva dritto.

## Precedenza sulle decisioni di prima

**Rispetto all'ADR 0012**, che teneva la risoluzione *fuori* dal dominio: quella scelta regge
ancora. La risoluzione resta un dettaglio del telefono che Regia impone a runtime e non un campo
del progetto; la rotazione è un fatto di **come la casa è montata**, che nessuno può dedurre e che
vale tutta la serata. Il commento in `gestore.ts` diceva «il giorno in cui una di queste voci entra
nel progetto, entra anche qui»: è quel giorno, ed è entrata solo lei. Quello che cambia è che la
risoluzione ora si **calcola** da ciò che il telefono dice del proprio sensore invece di essere una
costante — vedi più sotto — e che si manda anche fuori dal REC.

**Rispetto all'ADR 0013**, che leggeva l'orientamento dal video: il meccanismo resta e non dà
fastidio — costa un'occhiata all'SPS dei fotogrammi chiave, che Regia sta già spezzando — e
continua a segnalare nel Diario uno scambio di assi, che è un fatto vero quando capita. Ma non è
più la risposta alla domanda: la risposta la dà l'Operatore.

## La geometria che si chiede al telefono segue il sensore, non la rotazione

Girare l'immagine non basta, e la prova sul campo lo ha mostrato due volte. Alla prima, una
Telecamera dichiarata a 90° dava un'anteprima **minuscola** e un file **verticale**. Alla seconda,
corretta la prima, i video dichiarati a 0° uscivano con **280 px di nero per lato** — «sembra
croppato», ed era la descrizione esatta.

Il motivo è sempre lo stesso: il telefono non ritaglia mai. Prende quel che l'obiettivo gli dà e lo
**impagina** dentro la geometria che gli si è chiesta, riempiendo il resto di nero. Misurato il 19
settembre 2026 sul telefono della casa:

| geometria chiesta | fotogramma | immagine utile | nero |
|---|---|---|---|
| `1280x720` (quella dell'ADR 0012) | 1280×720 | **405×720** | 875 px di lato |
| `1280x960` | 1280×960 | 720×960 | 280 px per lato |
| `720x1280` | 720×1280 | 720×960 | 160 px sopra e sotto |
| **`960x1280`** | 960×1280 | **960×1280** | nessuno |

La tentazione era far seguire la geometria alla **rotazione dichiarata**: coricata per un quarto di
giro, dritta altrimenti. È sbagliato, e la seconda prova lo ha mostrato: la rotazione dice come si
vuole **vedere** il video, non come il telefono lo **produce**. Sono due cose indipendenti, e
confonderle rimette le bande nere ogni volta che l'Operatore dichiara 0.

Quel che conta è il verso in cui è montato il **sensore**, e il telefono lo dice:
`cameras[].sensorOrientation` in `/info.json`, per l'obiettivo attivo. Vale 90 o 270 su quasi ogni
telefono — il sensore è coricato rispetto al verso naturale dello schermo, l'app raddrizza
l'immagine, e quel che esce è **verticale**. Quindi `risoluzioneRipresa()` chiede un fotogramma
verticale quando il sensore è coricato, orizzontale quando non lo è, e non guarda affatto la
rotazione. Poi, se la Telecamera è montata di traverso, è la rotazione a raddrizzare la veduta —
nell'anteprima e nel file, non nella geometria.

Regia manda la geometria in quattro momenti: quando aggiunge una Telecamera, quando ne apre il
flusso, quando l'Operatore ne dichiara la rotazione e all'accensione del REC. Quello che conta di
più è il secondo, ed è l'unico che copre il caso vero: riaprire un progetto con un telefono
lasciato su un'altra geometria. Se è già quella giusta non si manda niente.

Questo estende l'[ADR 0012](0012-regia-fissa-la-risoluzione-durante-la-registrazione.md), che
toccava la risoluzione **solo durante il REC**. Il resto di quell'ADR regge intatto: il valore
resta concreto (`WxH`, mai `low|medium|high`), e serve ancora a spegnere l'adattamento che cambia
geometria a metà ripresa.

## ffmpeg nasce al primo byte, non all'accensione del REC

Cambiare la geometria fa ri-legare la camera al telefono, cioè **chiude il flusso** per un
istante. Con ffmpeg avviato subito all'accensione del REC, quella chiusura gli arrivava come fine
dell'ingresso: «could not find codec parameters», «End of file», processo morto e **nessun file
scritto**. Misurato: due tentativi, zero registrazioni.

La cura è spostare la nascita di ffmpeg al primo byte che arriva. Non è un'attesa in più — se il
flusso sta già scorrendo, il primo byte è lì — ed elimina una classe di guasto intera: qualunque
cosa succeda fra il REC e i byte (un cambio di geometria, un telefono che si sta svegliando, una
rete che tossisce) viene assorbita dal ciclo di ripresa che il registratore ha già.

Per la stessa ragione, **mentre una Telecamera registra Regia non le cambia la geometria**: la
rotazione dichiarata a metà ripresa vale dal file successivo, e il Diario lo dice invece di
spezzare il file in corso.

## Alternative scartate

**Mandare `?rotate=` al telefono.** Sembra la cosa giusta — ruota alla sorgente, e il file uscirebbe
già dritto senza matrice. Ma vuole l'app ≥ 0.13.1 (quella sui telefoni della casa è precedente, e
lì `rotate=` non tocca affatto `/video/h264`), e anche con l'app nuova, sull'obiettivo posteriore
cambia solo l'impaginazione dentro un fotogramma che resta orizzontale. In più scriverebbe una
preferenza persistente su un dispositivo che non è di Regia: il telefono resterebbe ruotato anche
dopo, e nessuno se lo ricorderebbe.

**Ricodificare con `transpose`.** Darebbe un file dritto per qualunque lettore, bande nere tagliate
comprese. Costa una ricodifica per Telecamera proprio dove il thread principale è già saturo
(ADR 0009), e per un guadagno che riguarda solo i lettori che non onorano la matrice.

**Ruotare la `<canvas>` con una trasformazione CSS.** Una riga invece di dieci, ma la scatola
dell'elemento non ruota con il suo contenuto: una cella verticale dentro una griglia pensata per
riquadri orizzontali uscirebbe dai bordi. Girare in fase di disegno tiene la tela coerente con ciò
che mostra, e la griglia continua a funzionare da sola.

**Una rotazione per Zona invece che per Telecamera.** Meno pulsanti, ma due Telecamere nella stessa
stanza possono essere montate in due modi diversi, ed è proprio il caso in cui serve.

**Far scegliere la geometria alla rotazione dichiarata.** È la strada che è stata presa e poi
disfatta il giorno stesso: sembra elegante — «la Telecamera è coricata, chiedo un fotogramma
coricato» — ma lega due cose indipendenti e rimette le bande nere su ogni Telecamera dichiarata
dritta. Il sensore è il dato giusto perché è l'unico che parla della **sorgente**.

## Conseguenze

- **Le bande nere se ne vanno dalla sorgente, non dal ritaglio.** Regia gira l'immagine e non la
  ritaglia mai: se il fotogramma arrivasse impaginato, girarlo lascerebbe il nero dov'è. È per
  questo che la cura sta nella geometria chiesta al telefono e non in un `crop`, che vorrebbe dire
  ricodificare.
- **Una registrazione in corso tiene la rotazione con cui è partita**: un file ha una sola matrice,
  scritta quando ffmpeg è partito. Cambiare rotazione durante il REC vale dal file successivo, e il
  Diario lo dice invece di lasciarlo scoprire dopo.
- **Resta da verificare sui lettori rigidi.** L'ADR 0012 ha già mostrato che Windows Media Player e
  Foto sono severi con ciò che sta nel contenitore. La matrice di rotazione è uno standard vecchio e
  largamente onorato, e ffmpeg e VLC la rispettano di sicuro — ma sul PC dell'evento va guardata con
  gli occhi, non data per buona.
- La rotazione cambia la forma della cella nella griglia: due Telecamere girate di 90° in una
  griglia da quattro riempiono meno spazio. È il prezzo di vedere le stanze dritte.

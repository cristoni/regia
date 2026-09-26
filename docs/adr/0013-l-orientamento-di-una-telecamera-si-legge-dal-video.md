# L'orientamento di una Telecamera si legge dal video, non si chiede al telefono

I telefoni della casa sono montati in piedi, e l'immagine che mandano è verticale. Quando uno
di loro passa in orizzontale durante l'Evento — perché qualcuno l'ha girato, perché è caduto
dal supporto, perché è stato rimontato — l'Operatore deve saperlo, e deve sapere **quale**: la
cella nella griglia cambia forma, ma con sei celle in una stanza buia non è detto che lo noti,
e una registrazione in corso cambia geometria a metà (ADR 0012).

## La decisione

Regia legge la geometria dell'SPS di **ogni fotogramma chiave** (`geometriaDi`, già scritto
per il taglio-segmento) e ne deriva l'orientamento: `verticale` se l'immagine è più alta che
larga, `orizzontale` altrimenti. Quando l'orientamento dell'ultimo chiave è diverso da quello
del precedente, il gestore delle Telecamere scrive una riga di Diario a livello `attenzione` e
segna l'istante nello stato (`orientamentoCambiatoIl`). L'interfaccia mostra la geometria vista
nella spia della cella e in Dispositivi, e per un minuto dal cambio segnala la Telecamera nella
barra di stato e con un'etichetta ambra sulla cella.

Il confronto è sull'**orientamento**, non sulla geometria: con `streamRes: "auto"` la geometria
cambia da sola a ogni rebind del telefono (1024×576 → 720×480, misurato per l'ADR 0012) senza
che nessuno l'abbia toccato, e una riga di Diario a ogni rebind sarebbe rumore. Un cambio di
verso, invece, è quasi sempre una mano.

La memoria dell'ultima geometria sopravvive alla sessione video: il flusso si apre solo se
qualcuno guarda, e se il telefono viene girato mentre nessuno guarda il cambio si dice al primo
chiave della sessione dopo, che è il primo momento in cui Regia può saperlo.

## Perché dal video, e non da `/info.json`

È la parte che vale l'ADR, perché la strada ovvia sarebbe l'altra: Regia interroga già ogni
telefono ogni tre secondi, e «chiedi al telefono com'è girato» suona più semplice di «leggi i
bit di un SPS».

Ma il telefono **non lo sa dire**. Letto nel sorgente di android-ip-camera (fatti verificati,
19 settembre 2026): `/info.json` riporta `cameras[].sensorOrientation`, che è fisso per
obiettivo, e `lensSettings.rotate`, che è la preferenza `rotate=` scritta a mano; in `settings`
c'è `streamRes`, che è la preferenza di risoluzione. Nessun campo dice la rotazione automatica
(`imageInfo.rotationDegrees`) né la dimensione del video che sta uscendo. E dalla v0.13.1 (PR
#101, 17 settembre 2026) la rotazione — automatica più preferenza, arrotondata ai 90° — è
**cotta nel flusso H.264 con gli assi scambiati**: un telefono in piedi con `stream_res=1280x720`
dichiara `720x1280` nell'SPS. L'unico posto in cui la geometria vera compare è il flusso, e
Regia quel flusso lo sta già spezzando fotogramma per fotogramma.

C'è un secondo motivo, più solido del primo: leggere dal video vale **qualunque sia la causa**.
Rotazione fisica seguita da un rebind, `?rotate=90` dato dal pannello web del telefono, un'app
riavviata in un altro verso, una versione dell'app che ruota diversamente: tutte finiscono
nello stesso SPS. Una regola sul telefono coprirebbe la sola causa per cui è stata scritta.

## Alternative scartate

**Confrontare la geometria, non l'orientamento.** Più semplice, e già fatto nel `MuxTs` per il
taglio-segmento. Ma lì serve, perché un contenitore MP4 dichiara una sola dimensione; qui
farebbe scrivere «ruotata» a ogni rebind di `auto`, cioè a ogni cambio di luce. Il taglio del
segmento resta dov'è e continua a fare il suo lavoro: le due regole hanno due scopi diversi.

**Un avviso persistente finché l'Operatore non conferma.** Sarebbe più difficile da perdere,
ma durante l'Evento nessuna finestra blocca e nessuna azione è obbligatoria (§5.2); e un
telefono girato di proposito nel pomeriggio resterebbe segnalato tutta la sera. Un minuto nella
barra di stato e sulla cella, poi solo la parola «verticale»/«orizzontale» nella spia: il Diario
tiene la riga per sempre.

**Chiedere all'upstream un campo in `/info.json`.** Giusto da chiedere, e non esclude questa
decisione; ma dipenderebbe dalla versione dell'app sui telefoni e arriverebbe ogni tre secondi,
mentre il chiave arriva ogni secondo e non dipende da nessuno.

**Portare l'orientamento nel dominio** (un campo su `zTelecamera`, «questa Telecamera deve
essere verticale») per segnalare lo scostamento dal voluto. Costa una migrazione e una voce di
interfaccia per un bisogno che non c'è: chi monta i telefoni li mette come vuole, e Regia deve
solo dire quando cambiano. Se un giorno servirà, entrerà allora, nel dominio e qui insieme.

## Conseguenze

- Un giro di **180°** non scambia gli assi: da un SPS non si vede, e Regia non lo segnala. Lo
  stesso per `mirror`. È un limite dichiarato, non un bug.
- Con un'app **precedente alla 0.13.1** `/video/h264` esce nel verso del sensore qualunque cosa
  faccia il telefono (issue #100 upstream): l'orientamento letto è sempre orizzontale e nessun
  cambio si vede. Va verificata la versione sui telefoni della casa.
- La rotazione fisica **da sola** può non cambiare il flusso: l'app lega la camera al ciclo di
  vita del servizio, senza ascoltatori di orientamento, e `rotationDegrees` si aggiorna al
  rebind successivo. Da misurare sul campo con `auto` (i rebind spontanei ci sono) e con una
  risoluzione fissa (non ci sono, finché non cambia qualcosa).
- Il cambio si vede al chiave successivo, cioè entro un secondo; il Diario e lo stato arrivano
  insieme all'istantanea seguente.
- Durante una registrazione compaiono due righe: «ruotata» dal gestore e «chiudo il segmento»
  dal registratore. Dicono due cose diverse, e vanno bene tutte e due.
- `orientamentoDi` decide che un quadrato è orizzontale. Nessun telefono manda quadrati; è
  scritto perché la regola non abbia buchi.

## Cosa è stato letto, e cosa resta da misurare

Letto nel sorgente upstream (`H264StreamingEncoder.kt`, `StreamingServerHelper.kt`,
`CameraXCapture.kt`, `StreamingService.kt`, il manifest e il diff della PR #101) il 19
settembre 2026: le righe `[sorgente]` stanno in [`docs/fatti-verificati.md`](../fatti-verificati.md).
Provato qui con SPS veri generati da libopenh264 (720×1280, 360×640, 1080×1920) contro un
telefono finto che manda due chiavi di verso diverso. **Non ancora provato contro un telefono
vero**: la versione dell'app sui telefoni della casa, e se e dopo quanto la rotazione fisica
arriva nel flusso, sono le due misure che mancano.

---

## Correzione del 19 settembre 2026, misurata sul telefono vero

**La decisione qui sopra è giusta per un solo percorso dell'app, e il telefono della casa non
prende quello.** Provata contro `192.168.1.7` (obiettivo posteriore `0:2`, `streamRes=1280x720`)
con Regia viva: il fotogramma chiave dichiara `1280x720` e, decodificato, contiene **un'immagine
verticale impaginata fra due bande nere**. Regia scriveva «orizzontale» sotto un'anteprima
verticale, che è esattamente la bugia che questo ADR voleva evitare.

Il motivo sta in `StreamingService.kt`: quando `supportsSurfaceEncoder()` è vero — obiettivo
**posteriore** e HAL `FULL` o `LEVEL_3`, cioè il caso normale delle telecamere della casa —
l'encoder nasce una volta sola con `H264HardwareEncoder(want.width, want.height, …, useSurface =
true)` e `CameraGlPipe` **impagina** il contenuto ruotato dentro quella geometria fissa
(`glViewport` con le bande). Gli assi non si scambiano mai. Il ramo che li scambia
(`H264StreamingEncoder.processFrame`, `outW = image.height`) esce subito in modalità surface
(`if (enc != null && enc.useSurface) return`), e serve solo all'obiettivo frontale o agli HAL
`LIMITED`/`LEGACY`.

In più, l'app installata su quel telefono è **precedente alla 0.13.1**: il suo pannello contiene
`h264Rotation()`, la funzione che la PR #101 ha rimosso. Lì `rotate=` non tocca affatto
`/video/h264` (issue #100 upstream).

Conseguenze, tutte misurate quel giorno:

- Girare fisicamente il telefono **non cambia niente** di ciò che esce: né la geometria del
  fotogramma, né `/info.json`, né lo scatto (4000×3000 anche con il telefono in piedi). Lo stream
  si ferma un istante — la camera si ri-lega — e riprende identico.
- `?rotate=90` viene accettato (`/info.json` passa a `"rotate": "90"`) ma l'immagine in
  `/video/h264` resta la stessa, bande nere comprese.
- Quindi **su quel telefono questa rilevazione non può scattare**, e nessuna scelta di
  implementazione lo cambia: l'informazione non esce dal telefono.

Cosa resta in piedi: il meccanismo — leggere la geometria dall'SPS di ogni fotogramma chiave e
segnalare uno scambio di assi — è corretto e costa nulla, e scatta dove gli assi si scambiano
davvero (obiettivo frontale, HAL `LIMITED`/`LEGACY`, app ≥ 0.13.1). Cosa cade: la promessa di
dire **da che verso sta l'immagine**. L'interfaccia perciò non scrive più «verticale» o
«orizzontale» accanto a un'anteprima: scrive la geometria del fotogramma e basta, e il Diario
dice «il fotogramma è passato da A a B». `CONTEXT.md` ha perso la voce *Orientamento* e ha
guadagnato *Fotogramma*.

Le tre strade per avere davvero la rilevazione, in ordine di costo, **non ancora scelte**:
aggiornare l'app dei telefoni alla 0.13.1 o successiva e comandare la rotazione da Regia (allora
`/info.json` dice `rotate` e l'immagine cambia per davvero); leggere le bande nere dai pixel
decodificati (in una casa al buio una scena nera e una banda nera si somigliano troppo, e il
motore oggi non decodifica); chiedere a monte un campo che dica il verso dell'immagine emessa.

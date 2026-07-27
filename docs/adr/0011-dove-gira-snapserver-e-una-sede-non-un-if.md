# Dove gira snapserver è una Sede, non un `if`

Regia è nata per Windows, e su Windows snapserver non gira nativo
([ADR 0002](0002-il-server-audio-non-gira-nativo-su-windows.md)): sta dentro una distro WSL
([ADR 0003](0003-regia-si-porta-la-propria-distro-wsl.md)), la si raggiunge con `wsl.exe`, e
tutto ciò che si vuole dirle passa da lì. Su Linux non è vera nessuna delle due cose:
`BUILD_SERVER` è escluso soltanto `if(NOT WIN32)`, quindi il server si compila e gira sulla
macchina stessa, come l'utente che ha fatto login.

Far girare Regia anche su Linux vuol dire quindi decidere una cosa sola: **dove va a finire
quella differenza**. Sparsa nel motore o raccolta in un posto.

## La decisione

Raccolta in un posto, dietro un'interfaccia che si chiama **Sede** — la macchina, vera o
virtuale, dove gira il server audio — e che vive in `snapcast/sede.ts` e in nessun altro file.
Chi la sceglie è una funzione sola, `sedeDi()`, e sceglie guardando `process.platform`: WSL su
Windows, la macchina stessa altrove. Non c'è un'impostazione da indovinare e non c'è un caso
misto.

Il supervisore, che è il pezzo che avvia snapserver e lo tiene somigliante al progetto, **non
contiene più nessun `process.platform` e nessun `wsl.exe`**. Sa che c'è una Sede, che dentro
c'è snapserver, che ci si scrivono file e ci si eseguono comandi. Dove finisca quel comando —
dentro una macchina virtuale o dentro una `bash` a due centimetri da lui — non è affar suo.

## Il punto che vale l'ADR: due valori che sembravano lo stesso valore

Prima della Sede esisteva un solo `indirizzoDistro()`, e serviva **due consumatori diversi**:

1. l'indirizzo a cui il thread audio apre le tredici socket delle sorgenti;
2. la destinazione a cui il ponte di rete inoltra
   ([ADR 0010](0010-il-ponte-di-rete-fa-parte-di-regia.md)).

Su Windows coincidono, ed è per questo che per mesi sono stati la stessa funzione. **Su Linux
divergono**, e non di poco: l'indirizzo delle sorgenti è `127.0.0.1` — che lì è la risposta
giusta e non un ripiego, perché gli inoltri fantasma di WSL, che sopravvivono al processo che
ascoltava, semplicemente non esistono — mentre il ponte **non va aperto affatto**, perché
snapserver ascolta già su `0.0.0.0` e i telefoni lo raggiungono da soli.

Tenerli uniti avrebbe prodotto la cosa peggiore che possa uscire da un porting: **una riga di
Diario falsa su un sistema che funziona.** L'unico indirizzo disponibile sarebbe stato
`127.0.0.1`, `Ponte.apri()` l'avrebbe rifiutato — è di loopback, e l'ADR 0010 lo vieta apposta
— e Regia avrebbe scritto all'Operatore «i telefoni potrebbero non vedere il server audio»
mentre i telefoni lo vedevano benissimo. Qualcuno avrebbe passato una serata a cercare un
guasto che non c'è.

Da qui i due membri separati: `indirizzoFlussi()`, che risponde sempre, e `serveIlPonte`, che
è un booleano della Sede e non una deduzione fatta a valle. Il supervisore chiede il primo
comunque — al thread audio serve in tutti e due i casi — e apre il ponte solo se il secondo è
vero. Su Linux non aprirlo **è una scelta detta**, non una dimenticanza.

## Lo stesso errore una seconda volta: il rimedio non si deduce dal motivo

`indisponibile()` non torna una stringa. Torna `MotivoIndisponibile | null`, cioè
`{ motivo, rimedio }`, e i due campi viaggiano insieme perché **chi sa qual è il rimedio è chi ha
fatto la diagnosi**. È la stessa forma del paragrafo qui sopra vista da un'altra porta: un valore
che il chiamante non può ricostruire da ciò che riceve. Lì era il bisogno del ponte, qui è cosa
deve fare l'Operatore.

Prima erano una stringa sola, e il rimedio l'interfaccia se lo indovinava dal testo del motivo.
`SedeWsl` ha due casi che da fuori si somigliano — «WSL non c'è» e «WSL c'è ma non quella
distro» — e sono finiti sotto lo stesso consiglio. Il primo si rimedia con `wsl --install`,
Virtual Machine Platform, la virtualizzazione abilitata da BIOS e **un riavvio del PC**; il
secondo con un menu a tendina nelle Impostazioni. Il consiglio unico era il primo, e il caso
più frequente è il secondo: il primo avvio su un PC Windows dove WSL c'è già e manca soltanto la
distro di Regia. A quella persona — che è la persona più comune che Regia incontri — l'interfaccia
diceva di riavviare il computer per un guasto che si risolve senza chiudere niente.

Non è un difetto che si nota rileggendo il codice: tutti e due i rami producevano una frase vera,
e la deduzione stava in una riga sola in un file lontano. Si nota provando il caso comune. Da qui
il rimedio attaccato al motivo fino in fondo: `AmbienteVivo` porta `sedeRimedio` accanto a
`sedeMotivo`, e l'interfaccia li accosta senza metterci niente di suo — quando il rimedio è
`null` non ne inventa uno.

`SedeLocale.indisponibile()` torna sempre `null`, e non per pigrizia: la Sede *è* la macchina, e
la macchina non può mancare. Ciò che può mancare è snapserver, e a quello risponde `snapserver()`.
Due domande separate, due risposte separate — impastarle avrebbe rimesso su Linux esattamente
l'ambiguità appena tolta da Windows.

## Il cancello di versione

Sotto la **0.33** il file di configurazione che sappiamo scrivere non è quello giusto.

Nella 0.33 la sezione `[tcp]` è stata rinominata `[tcp-control]` e le impostazioni di
streaming TCP sono uscite da `[stream]` per finire in `[tcp-streaming]` (`changelog.md` di
badaix/snapcast, 0.33.0). La 0.35 accetta ancora le vecchie forme come deprecate, con un
avviso; nella direzione opposta non c'è nessuna tolleranza, perché non poteva essercene: un
binario del 2022 non può conoscere un nome inventato nel 2025.

Su Windows la cosa quasi non si poteva vedere: snapserver dentro la distro ce lo mette Regia —
oggi `banco/prepara.ts`, domani l'installer dell'ADR 0003 — sempre alla 0.35 fissata. Su Linux
lo installa qualcun altro, e l'apt di Ubuntu 24.04 dà la **0.27.0** (fatto già registrato
nell'ADR 0003). È la versione che si becca chi fa `apt install snapserver` senza sapere, cioè
quasi tutti, la prima volta.

Perciò `avvia()` **cerca il binario e ne legge la versione prima di scrivere la
configurazione**, e se è più vecchia della 0.33 si ferma dicendolo. Rifiutare di partire è
sgradevole; partire storti lo è molto di più. Il sintomo di un avvio storto si scopre a metà
serata — i telefoni non si collegano, e nel log del server non c'è nessun errore, perché per
snapserver non è successo niente di anomalo: ha letto un file, ha ignorato ciò che non
conosceva, e ha aperto le porte con i default suoi.

Quel «ha ignorato in silenzio» **non è stato osservato su una 0.27 vera**: è la ragione per cui
il cancello esiste, non una misura. Il punto del cancello è precisamente che nessuno debba
scoprirlo alle nove e mezza di sera.

## Le conseguenze, comprese quelle scomode

**Su Linux Regia gira come l'utente che ha fatto login**, non come root dentro una distro
dedicata a lei. Non è un dettaglio di permessi: cambia tre cose.

- **Il `datadir` non può più essere `/var/lib/snapserver`**, che era il default scritto nel
  generatore di configurazione. Quella cartella la crea il pacchetto Debian di upstream a
  `0750`, di proprietà dell'utente di sistema `snapserver`
  (`extras/package/debian/snapserver.postinst`): esiste, ed è esattamente non nostra. Il
  `datadir` ora viene dalla Sede, che lo tiene dentro la propria cartella di lavoro. Lo stato
  che snapserver ci scrive lo ignoriamo comunque — il progetto è la verità, e Snapcast è una
  proiezione (ADR 0005) — ma se non può scriverlo, non parte.
- **La cartella di lavoro sta in `XDG_RUNTIME_DIR`**, non in `/tmp/regia`. Dentro la distro
  `/tmp/regia` era senza rischi, perché la distro è dedicata e i comandi girano come root. Su
  una macchina condivisa quella cartella appartiene al primo che la crea, e il secondo utente
  che lancia Regia non ci può scrivere. `XDG_RUNTIME_DIR` è per utente e viene ripulita al
  logout: è il posto previsto per questa roba. Dove non c'è — una console senza sessione, un
  `ssh` — si ripiega su una cartella nel temporaneo **legata all'utente**, che è la stessa
  proprietà per un'altra strada.
- **`pkill -x snapserver` non tocca il server di sistema.** Molte distribuzioni impacchettano
  `snapserver.service`, che gira sotto l'utente `snapserver` (`User=snapserver` nella unit di
  upstream) e tiene 1704, 1705 e 1780. Il nostro `pkill` gira come l'utente che ha fatto login
  e non ha il permesso di segnalarlo — né deve averlo: quel server è di qualcun altro. Dal log
  si vedrebbe solo un `address already in use` senza un nome. Quindi quando l'avvio fallisce il
  supervisore **chiede chi tiene la porta**, con `systemctl is-active snapserver`, e se la
  risposta è `active` lo dice per nome e dice anche come si spegne. Se non riesce a chiedere non
  inventa niente: l'errore resta quello che era.

- **Ma lo stesso `pkill` tocca gli altri snapserver dello stesso utente, e questo non è
  gestito.** È il rovescio esatto del punto sopra: il filtro dei permessi che protegge il server
  di sistema non protegge un snapserver che l'Operatore avesse acceso a mano dal suo terminale —
  per una prova, per un'altra stanza, per qualunque motivo. Regia lo spegne senza chiedere, e
  senza dirlo. Dentro la distro dedicata dell'ADR 0003 il caso non esiste, perché lì l'unico
  snapserver possibile è il nostro; su un PC Linux è possibile e nessuno lo sta impedendo.
  Si accetta per adesso — un `--pidfile` o un filtro sul percorso della configurazione lo
  chiuderebbero — ma va scritto, perché è comportamento nuovo che esiste solo su Linux e chi lo
  incontrasse lo leggerebbe come un guasto invece che come una scelta non ancora presa.

**Un server già acceso non si adotta più alla cieca.** Riagganciarsi a snapserver invece di
riavviarlo è una cosa che vale la pena fare — è staccato con `setsid` apposta per sopravvivere
alla chiusura di Regia, e riavviarlo sarebbe due secondi di silenzio gratuiti. Ma dentro la
distro dell'ADR 0003 l'unico snapserver acceso è per forza il nostro, mentre su Linux no: il
`snapserver.service` del pacchetto risponde a `Server.GetStatus` esattamente come risponderebbe
il nostro. Adottarlo vuol dire dichiararsi `acceso` e poi riempire il Diario di «Stream not
found» per tutta la serata, perché gli stream li crea il file di configurazione e quello è il
suo. Ora si guarda: se non ha i nostri Flussi, non è nostro, e `avvia()` fa il suo lavoro.

**Il ponte sparisce, e con lui sparisce il suo prezzo.** Su Windows snapserver vede tutti i
client all'indirizzo del ponte invece che al loro, e `AltoparlanteVivo.indirizzo` è
inutilizzabile — l'interfaccia scrive «via ponte» apposta. Su Linux quell'indirizzo torna
vero. È l'unica cosa che il porting *aggiunge* invece di togliere.

**`progetto.server.distro` resta com'è, e `VERSIONE_PROGETTO` resta 1.** Il campo su Linux non
significa niente, e la tentazione di renderlo opzionale o di alzare la versione dello schema è
forte. Non si fa: un `progetto.json` scritto su Windows deve aprirsi su Linux e viceversa,
perché il file di progetto è la cosa che viaggia fra le macchine. Su Linux il campo si ignora e
il controllo si nasconde nelle Impostazioni. Portarsi dietro un campo morto per metà delle
piattaforme è il prezzo, ed è più basso di quello di due formati.

**L'interfaccia non può dedurre il sistema dal proprio ambiente**, quindi `AmbienteVivo` porta
un campo `piattaforma` che dice su cosa gira *il motore*. Non è ridondante: `--rete` serve
l'interfaccia vera via HTTP, e il tablet della Fase 3 è un secondo client identico che può
girare su qualunque cosa parlando con un motore Linux. Un `navigator.userAgent` risponderebbe
alla domanda sbagliata. Accanto viaggiano `sedeDescrizione`, `sedeMotivo` e `sedeRimedio`, cioè
la stessa idea portata un passo più in là: non solo *dove* gira il motore, ma cosa c'è di rotto
nella sua Sede e cosa farci. Il campo `wsl` che c'era prima **non esiste più** — rispondeva sì o
no a una domanda che su Linux non si pone, e chi la faceva restava senza risposta invece che con
la risposta giusta.

**macOS finisce nel ramo locale, non provato.** Snapserver ci compila — `BUILD_SERVER` è
escluso solo per WIN32 — ma nessuno l'ha mai eseguito lì. Vale quel che vale; almeno non
pretende un `wsl.exe` che su macOS non esiste.

## Alternative scartate

**Due rami `if (process.platform === 'win32')` dentro il supervisore.** È la strada più corta,
ed è quella che il codice aveva già iniziato a prendere. Non è stata scartata per gusto di
astrazione ma per una ragione che si tocca con mano nei test: il supervisore ha bisogno di
collaudare «il server non può partire», e con i rami in linea quel collaudo dipende da cosa c'è
installato sulla macchina che esegue i test. Su un Linux con snapserver nel PATH, il test che
verifica il fallimento **avvierebbe un server vero**. Con la Sede dietro un'interfaccia,
`OpzioniSupervisore.sede` è iniettabile e il test dice quello che vuole dire. E poi i rami non
sarebbero stati due: l'indirizzo, il ponte, il `datadir`, la cartella di lavoro, la ricerca del
binario, il messaggio d'errore — sei posti diversi in tre file, ognuno con la sua occasione di
restare indietro.

**Un secondo eseguibile, o un pacchetto separato, per Linux.** Sembra pulito finché non si
guarda cosa sarebbe rimasto in comune: il protocollo su WebSocket, l'interfaccia, il formato di
progetto, i mixer, il thread audio, il video. Cioè tutto tranne una manciata di righe. La
differenza non sta *nel prodotto*, sta in una funzione che sceglie dove mandare un comando;
duplicare il prodotto attorno a quella funzione significa duplicare anche ogni cosa che non
cambia, e poi tenerle allineate a mano. In più il tablet della Fase 3 è un client del motore, e
un client non sa — e non deve sapere — di che sapore è il motore a cui si collega: due pacchetti
avrebbero comunque avuto un protocollo solo e un'interfaccia sola da far funzionare in tutti e
due i casi. Il ramo sarebbe tornato, solo più in là e in un posto peggiore.

**Un container anche su Linux, per avere una sola strada.** È l'idea più seducente delle tre:
Docker o Podman ovunque, la stessa immagine, la stessa versione fissata, e la Sede diventa
inutile. Ma nega la premessa stessa del porting — su Linux **il sistema operativo è già quello
che a snapserver serve**, e mettergli intorno un contenitore vuol dire ricomprare esattamente
tutti i costi che l'ADR 0003 e la sua correzione hanno documentato: un indirizzo che cambia,
l'inoltro delle porte da configurare, la rete del contenitore che non è la LAN, e in più un
demone da installare e un utente da mettere in un gruppo. In cambio si otterrebbe l'uniformità,
che è precisamente ciò che l'interfaccia `Sede` fornisce già a costo zero. Si pagherebbe in
rete una cosa che si può avere in tipi.

## Cosa è stato misurato, e cosa no

Il 10 settembre 2026 `SedeLocale` è stata eseguita **dentro la distro `Ubuntu` di questa
macchina**, che è un kernel Linux vero: snapserver 0.35 trovato da sola, `snapserver.conf`
generata, il processo avviato **nativamente**, l'RPC collegato, quattro Flussi dichiarati per tre
Zone più i non assegnati, il ponte che non si apre e il `datadir` sotto `XDG_RUNTIME_DIR`. Nella
stessa sessione si è verificato che il percorso Windows non si è rotto — Sede WSL, IP della
distro, ponte aperto — e che un snapserver estraneo, che a `Server.GetStatus` risponde come il
nostro, **non viene adottato** perché non ha i nostri Flussi. Le righe stanno in
[`docs/fatti-verificati.md`](../fatti-verificati.md).

**Non è la stessa cosa di una macchina Linux vera**, e la differenza va ripetuta ogni volta che
si cita questa prova: dentro la distro non c'è nessun telefono, nessuna sessione grafica, nessun
pacchetto, e l'orologio è quello storto di WSL. Tutto ciò che dipende da quelle quattro cose —
che i telefoni raggiungano snapserver senza ponte, che il Passo del Flusso torni al 100%,
l'anteprima dei Suoni dalle casse del PC, l'AppImage e il `tar.gz` — resta nell'elenco in fondo a
quel file, e ci resta per una ragione nominata caso per caso.

I test continuano a girare su una Sede finta, apposta perché non dipendano dalla macchina che li
esegue: dicono che il supervisore si comporta come deve dato un certo esito dei comandi, non che
quei comandi facciano quello sulla Sede vera. Resta il loro mestiere, ed è un altro.

## Correzione (18 settembre 2026): un server estraneo non fa fallire l'avvio, lo fa «riuscire»

Il paragrafo sul `pkill` qui sopra dice che «quando l'avvio fallisce il supervisore chiede chi
tiene la porta». Poggiava su un'assunzione mai misurata: che snapserver, non potendo aprire le
sue porte, **esca**. Sulla macchina del committente — Ubuntu 26.04, `snapserver.service`
abilitato — si è visto che non esce: la 0.35 scrive `bind: Address already in use` per 1704,
1705 e 1780 e **continua a girare** con le sole sorgenti dei Flussi aperte. Il `pgrep` lo
trovava vivo, l'avvio «riusciva», e sulla porta di controllo rispondeva il server di sistema:
Regia si dichiarava `acceso`, scriveva «Stream not found» ogni cinque secondi e il telefono
finiva in uno stream che nessuno scrive. È esattamente la serata che l'ADR voleva evitare, e il
controllo di `adotta()` — che c'era ed era giusto — non bastava, perché `avvia()` non ci passava.

Tre cose cambiano, e la prima è la decisione vera.

**La prova che il server sulla porta di controllo è il nostro è che abbia i Flussi del
progetto, e la si fa a ogni collegamento.** Non «il processo esiste» (`pgrep`), non «risponde a
`Server.GetStatus`» (risponde anche quello di sistema), non «il log non ha errori». Il controllo
sta dentro `collegaEVerifica()`, prima di toccare `osservato`, `vivi` e `situazione`, e fallisce
con un errore che ha un nome — `ServerEstraneo` — perché chi lo riceve deve poterlo distinguere
da «non risponde nessuno»: a un server che non risponde si riprova, a un server estraneo no.
`adotta()` diventa un chiamante come gli altri, e la sua clausola «non ha i Flussi» sparisce da
lì perché vale ovunque.

**Quando dopo l'avvio risponde un altro, il nostro si spegne.** Lasciarlo vivo vorrebbe dire
scrittori `attivo` su un server sordo, che è una bugia più fine della precedente. È nostro, il
`pkill` lo tocca; poi il messaggio dice quali porte tiene chi, riporta la riga `Address already
in use` dal log, e — se `systemctl is-active snapserver` risponde `active` — nomina il servizio e
il comando che lo toglie di mezzo, `sudo systemctl disable --now snapserver`. Lo stesso nome del
colpevole compare già all'avvio di Regia, quando `adotta()` lo incontra: è il momento in cui
l'Operatore ha ancora il pomeriggio davanti. Il `pgrep` dell'avvio si limita ai processi
dell'utente (`-u "$(id -u)"`), così un servizio sotto un altro utente non passa nemmeno per
«avviato»; resta un controllo di esistenza, non di identità.

**Il client RPC segue `portaControllo`.** Parlava a `127.0.0.1:1705` fisso mentre il file di
configurazione seguiva l'impostazione: cambiare la porta in Impostazioni avrebbe fatto parlare
Regia con un'altra porta, e cioè con chiunque ci ascoltasse. Non c'entra con il servizio di
sistema, ma è saltato fuori provando a far convivere il nostro server con quello.

Il rischio accettato più sopra — il `pkill` che spegne un snapserver acceso a mano dallo stesso
utente — resta com'era. Le misure stanno in `docs/fatti-verificati.md`, sezione «Su una Ubuntu
vera, 18 settembre 2026».

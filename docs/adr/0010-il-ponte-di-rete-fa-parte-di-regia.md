# Il ponte di rete fa parte di Regia, e si parla alla distro per indirizzo

`docs/fatti-verificati.md` lasciava aperta una scelta: «Resta da decidere se quel ponte diventa
parte di Regia o se si pretende `mirrored`, e [ADR 0003](0003-regia-si-porta-la-propria-distro-wsl.md)
va aggiornato di conseguenza». Questo ADR la chiude, e ne chiude una seconda che nessuno aveva
ancora visto.

## La decisione

**Regia apre da sé un ponte TCP in spazio utente da `0.0.0.0` alla distro**, sulle porte del
server audio (1704 flusso, 1705 controllo, 1780 HTTP), e lo apre **solo se serve**.

E, altrettanto vincolante: **tutto ciò che Regia manda al server audio va all'indirizzo IP della
distro, mai a `127.0.0.1`.** Vale per il ponte e vale per le tredici socket delle sorgenti che
apre il thread audio.

## Perché non si pretende `mirrored`

In `networkingMode=NAT` — la configurazione di un Windows di fabbrica — WSL inoltra le porte in
ascolto **solo su `127.0.0.1`**: Windows raggiunge snapserver, il telefono no. `mirrored`
risolverebbe, ma non è il default, richiede una versione recente di WSL, e **su questa macchina si
è rotto da solo** dopo un aggiornamento di Windows, ricadendo su `None` senza preavviso. Costruire
il collaudo su una configurazione che il sistema operativo può togliere fra un martedì e l'altro
significa avere un'app che smette di funzionare senza che nessuno abbia toccato niente.

`netsh interface portproxy` farebbe la stessa cosa in modo più pulito, ma **vuole
l'amministratore**, e il §6 vuole un'installazione senza passaggi manuali. Un ponte in spazio
utente non lo vuole, ed è bastato a far collegare un Pixel 10 vero.

## Il ponte si accende da solo, o non si accende

Non c'è un'impostazione da indovinare. Il ponte prova ad ascoltare su `0.0.0.0:<porta>`:

- se **riesce**, quella porta non era raggiungibile dall'esterno e il ponte serve;
- se fallisce con `EADDRINUSE`, qualcun altro — `mirrored` funzionante, un portproxy messo a mano —
  la serve già, e il ponte si fa da parte.

È la rete a dire in che modo è configurata, invece di un flag che qualcuno dovrà ricordarsi.

## `127.0.0.1` non è un sinonimo dell'indirizzo della distro

È la parte che è costata di più, ed è controintuitiva perché per mesi ha funzionato.

**`0.0.0.0` contiene `127.0.0.1`.** Un ponte che ascolta su `0.0.0.0:1705` e inoltra a
`127.0.0.1:1705` **si collega a se stesso**. Il giro a vuoto che ne esce accetta connessioni
all'istante e non risponde mai: per chiunque guardi solo l'esito di `connect()` è indistinguibile
da un server acceso. Il supervisore adottava il proprio ponte, si dichiarava `acceso`, e non
avviava mai snapserver.

E anche senza ponte, `127.0.0.1` resta una cattiva idea: **gli inoltri che WSL crea su loopback
sopravvivono al processo che ascoltava**. Dopo che snapserver muore, `connect()` su
`127.0.0.1:4953` continua a riuscire, i byte partono, e non li legge nessuno. Il thread audio
scriveva Flusso perfetto dentro un fantasma.

Da qui due regole che valgono ovunque nel codice:

1. **La destinazione del ponte non può essere un indirizzo di loopback.** Se l'indirizzo della
   distro non si riesce a leggere, il ponte **non si apre**: meglio dei telefoni che non si
   collegano che dei telefoni collegati a niente.
2. **Una `connect()` che riesce non prova che dall'altra parte ci sia snapserver.** L'unica prova
   è una risposta: `Server.GetStatus` sul canale di controllo, e lo stato dello stream che passa
   da `idle` a `playing` sulle sorgenti. È la stessa lezione già scritta in `presa-tcp.ts` per le
   socket delle sorgenti — vale identica per la porta di controllo.

## Cosa si paga

Snapserver vede tutti i client all'indirizzo del **ponte**, non al loro: un telefono a
`192.168.1.7` compare come l'indirizzo del PC sulla rete WSL. Il riconciliatore non ne soffre —
abbina per client id, che è stabile per dispositivo — ma il campo `indirizzo` di
`AltoparlanteVivo` diventa inutilizzabile finché si passa di lì, e **l'interfaccia lo dice**
("via ponte") invece di mostrare un indirizzo falso.

## Alternative scartate

- **Pretendere `mirrored`**: si è rotto da solo su questa macchina, e non è il default.
- **`netsh portproxy` chiesto in Setup**: vuole l'amministratore, e il §6 vuole zero terminale.
- **Snapserver nativo su Windows**: impossibile senza portare il progetto — vedi
  [ADR 0002](0002-il-server-audio-non-gira-nativo-su-windows.md).
- **Far parlare i telefoni direttamente all'IP della distro**: l'indirizzo NAT non è raggiungibile
  dalla LAN, e cambia a ogni riavvio della distro.

## Correzione, 9 settembre 2026

La sezione «Cosa si paga» diceva che un telefono a `192.168.1.7` compare come `127.0.0.1`.
L'indirizzo era giusto solo per il ponte di allora, che inoltrava verso loopback — cioè per la
configurazione sbagliata che questo stesso ADR ha poi vietato. Con il ponte che punta alla distro,
un `Server.GetStatus` di oggi mostra il Pixel 10 come `172.30.224.1`: **l'indirizzo del PC sulla
rete della distro**, non `127.0.0.1`.

La sostanza non cambia, ed è quella che conta: l'indirizzo che snapserver riporta **non è quello
del telefono** finché si passa dal ponte, il riconciliatore non ne soffre perché abbina per client
id, e l'interfaccia scrive "via ponte" invece di mostrare un indirizzo falso.

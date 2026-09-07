# Il file di progetto è la verità, snapserver è una proiezione

L'associazione fra un Altoparlante e la sua Zona vive nel file di progetto di Regia, indicizzata
sull'id del client Snapcast (stabile per dispositivo). Snapserver ha un suo file di stato che
ricorda gruppi, nomi e volumi: **non ci fidiamo**. Regia ri-spinge l'intero stato desiderato a
ogni `Client.OnConnect`, a ogni `Server.OnUpdate` e dopo ogni riavvio del server.

Questo ciclo di riconciliazione non è codice di pulizia da aggiungere alla fine: è esattamente
ciò che fa passare i criteri di accettazione §8.4 (un telefono riavviato torna nella sua Zona da
solo), §8.7 (riaprendo l'app tutto si ricollega) e §8.8 (telefono che perde il Wi-Fi e torna).
Va progettato per primo.

## Gli stream nascono da una configurazione generata, e cambiarli riavvia il server

Regia scrive `snapserver.conf` con esattamente una sorgente `tcp://` per Zona (porta 4953+n),
più una per "Identifica". Creare, rinominare o eliminare una Zona riscrive la configurazione e
riavvia il server.

Le Zone si modificano nel pomeriggio, durante il setup, **mai durante l'evento**: un riavvio da
due o tre secondi in quel momento non costa nulla. In cambio non c'è nessuna dipendenza da RPC,
gli stream portano il nome vero della Zona (che chi prepara i telefoni vede in Snapdroid), e
c'è un solo percorso di codice invece di due.

## Alternative considerate

- **Pool fisso di 12 stream**, dichiarati una volta e mai toccati: eliminerebbe ogni riavvio,
  ma gli stream si chiamerebbero `zona-3` invece di "Ingresso", e Snapdroid mostrerebbe stream
  vuoti a chi sta configurando i telefoni.
- **`Stream.AddStream` a runtime**: disponibile nella 0.35 che ci portiamo dietro, accetta
  sorgenti `tcp`. Scartata perché è il metodo già rimosso una volta (CVE-2023-36177 in 0.30) e
  reintrodotto ristretto in 0.31 — una dipendenza su una superficie che upstream ha già
  dimostrato di essere disposto a togliere, in cambio di un riavvio che avviene solo in setup.

## La forma della proiezione: una Zona ↔ uno stream ↔ un gruppo

Si tiene il modello del §4.4. Ogni Zona ha il suo stream `tcp://` e il suo gruppo Snapcast, e
il gruppo contiene i client degli Altoparlanti di quella Zona. Esiste inoltre un gruppo
**"non assegnati"**, puntato a uno stream sempre silenzioso, che è dove finisce ogni client che
si connette prima di essere stato messo in una Zona.

L'alternativa considerata era **un gruppo per client**, ciascuno puntato allo stream della sua
Zona: avrebbe ridotto la riconciliazione a un solo `Group.SetStream` per client, eliminato
`Group.SetClients` e i gruppi vuoti, e reso Identifica banale anche sui telefoni non ancora
assegnati. Scartata perché avrebbe richiesto di verificare sul campo che due client sullo stesso
stream ma in gruppi diversi restino campione-sincroni — se non lo fossero, due Altoparlanti nella
stessa stanza produrrebbero flanging. Il modello per Zona garantisce la sincronia per costruzione.

Conseguenze da gestire: i gruppi vuoti spariscono da `Server.GetStatus` e vanno ricreati, e
l'appartenenza ai gruppi va riconciliata e non solo lo stream.

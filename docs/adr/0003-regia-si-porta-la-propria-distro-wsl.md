# Il server audio gira in una distro WSL2 che Regia si porta dietro

Dato che [snapserver non gira nativo su Windows](0002-il-server-audio-non-gira-nativo-su-windows.md)
e che il target è solo Windows, il server audio gira in WSL2. Ma **non** in una distro
dell'utente: l'installer contiene un rootfs Debian minimale con dentro il `.deb` ufficiale di
snapserver 0.35, e Regia lo registra con `wsl --import Regia-Snapserver`.

## Perché non `apt install`

Il §6 richiede che tutto funzioni **senza connessione a internet**: un `apt install` al momento
del setup lo viola. In più l'apt di Ubuntu 24.04 fornisce la **0.27.0** (2022), che ha un
formato di configurazione diverso da quello documentato oggi — in 0.33 la sezione `[tcp]` è
diventata `[tcp-control]` e le impostazioni di streaming TCP sono uscite da `[stream]`. Scrivere
un generatore di configurazione che copra entrambi i formati è tassa pura.

Portandoci la distro otteniamo: versione bloccata e identica su ogni macchina, distro Debian
scelta apposta perché il `.deb` ufficiale è Debian, nessun contatto con le distro già presenti
sul PC, e disinstallazione pulita con `wsl --unregister`.

## Conseguenze

- **Il §8.1 del documento di progetto non è raggiungibile e va riscritto.** WSL richiede
  Virtual Machine Platform, un riavvio, e la virtualizzazione abilitata da BIOS. Su un PC mai
  visto non esiste un percorso "15 minuti, nessun terminale". Il criterio realistico è:
  installazione assistita con un riavvio, **poi** 15 minuti.
- **Obblighi GPL-3.0.** Distribuiamo un binario di snapserver dentro il nostro installer. Il
  `.deb` va incluso non modificato, con la sua licenza e l'offerta scritta dei sorgenti. Il
  server resta un processo separato, quindi non contamina il codice di Regia.
- ~100–150 MB di installer in più.

## L'alternativa che è stata scartata, e perché merita di essere ricordata

Implementare il **server Snapcast dentro Regia** (protocollo binario su 1704 + abbastanza
JSON-RPC da soddisfare Snapdroid). Avrebbe dato un solo `.exe`, l'mDNS pubblicato da Windows,
e avrebbe cancellato tutto il §4.4: nessun allineamento zona↔gruppo↔stream, perché la mappa
client→Zona sarebbe già nostra. Il lato server della sincronizzazione temporale è la parte
facile del protocollo — il server timbra e rimanda, la matematica sta nel client.

Scartata perché Snapdroid è anche un controller JSON-RPC e una scatola nera che si aggiorna
per conto suo: un suo aggiornamento potrebbe rompere il nostro server durante la stagione.
Il livello audio resta comunque dietro un'interfaccia, quindi la strada non è murata.

---

## Correzione, dopo la ricerca tecnica

**Una promessa di questo ADR non e mantenibile cosi com'e scritta.**

Tutte le misure di rete sono state prese su questa macchina, dove `networkingMode=mirrored` era
**gia impostato prima** di iniziare — non e un default, e configurazione preesistente. Un
Windows 11 di fabbrica usa **NAT**, dove una porta in ascolto dentro la distro non e raggiungibile
dalla LAN senza `netsh portproxy` piu una regola firewall, entrambi con privilegi elevati.

Il problema e che `networkingMode` si imposta in `%USERPROFILE%\.wslconfig`, che vale **per
utente e per tutte le distro del PC**. Quindi la frase "nessun contatto con le distro gia presenti
sul PC" e falsa: per funzionare, Regia deve toccare una configurazione condivisa.

Restano tre strade, e la scelta va fatta con il telefono in mano, non a tavolino:

1. **Scrivere `.wslconfig`**, dopo aver mostrato all'utente che cosa cambia e per quali distro, e
   con la possibilita di rimetterlo com'era. Onesto, ma cambia una impostazione globale del PC e
   richiede un `wsl --shutdown` che ferma anche le altre distro.
2. **Restare in NAT e aprire un ponte da Windows**: `netsh interface portproxy` sulle porte 1704,
   1705, 1780 piu le regole firewall. Non tocca nessuna distro, ma aggiunge un pezzo di
   configurazione di rete di Windows che va creato, verificato e rimosso.
3. **Fare il ponte dentro Regia**: il motore ascolta sulla LAN e inoltra verso la distro. Nessuna
   configurazione di sistema, ma tutto il traffico audio dei telefoni passa dal nostro processo.

Nessuna e gratis. **La misura 1 di `docs/fatti-verificati.md` decide quale.**

## Correzione, 9 settembre 2026

La misura 1 e stata presa, e la scelta e la **terza**: il ponte sta dentro Regia. Il perche, le due
alternative scartate e il prezzo che si paga stanno in
[ADR 0010](0010-il-ponte-di-rete-fa-parte-di-regia.md).

Cade con essa anche la strada 1: **Regia non scrive `.wslconfig`** e non tocca nessuna
configurazione condivisa del PC. La promessa "nessun contatto con le distro gia presenti" torna
quindi vera — resta vero, pero, che la distro va scelta in Impostazioni, perche quella predefinita
di questo ADR (`Regia-Snapserver`) non esiste su una macchina qualsiasi.

---

## Correzione, 10 settembre 2026

**Su Linux questo ADR non si applica**, e non in parte: per intero.

Non c'è nessuna distro, perché snapserver gira sulla macchina stessa
([ADR 0011](0011-dove-gira-snapserver-e-una-sede-non-un-if.md)). Quindi niente rootfs Debian da
mettere nell'installer, niente `wsl --import`, niente `wsl --unregister` da spiegare a chi
disinstalla, niente ~100–150 MB, e niente `.wslconfig` da non toccare. La prima riga di questo
ADR — «dato che snapserver non gira nativo su Windows **e che il target è solo Windows**» — è
esattamente la premessa che è venuta meno: la conclusione resta valida sotto quella premessa, e
fuori non ha niente da dire.

### Cade anche la conseguenza più pesante

La prima delle Conseguenze qui sopra è la frase che ha fatto più danno al documento di progetto:
«il §8.1 non è raggiungibile», perché WSL richiede Virtual Machine Platform, la virtualizzazione
abilitata da BIOS e un riavvio, e su un PC mai visto non esiste un percorso «15 minuti, nessun
terminale».

**Su Linux quell'ostacolo non c'è.** Snapserver è un pacchetto: si installa senza riavviare,
senza toccare il BIOS e senza abilitare niente nell'hypervisor. Il costo passa da «un riavvio e
una visita nel BIOS» a «un pacchetto da mettere».

Il §8.1 però **non diventa automaticamente raggiungibile**, e sarebbe comodo dirlo e sbagliato:
quel criterio chiede anche «nessun terminale», e `sudo apt install snapserver` è un terminale.
Un `.deb` di Regia che dichiarasse snapserver fra le dipendenze lo soddisferebbe — ma **quel
`.deb` non si spedisce**: non è fra i bersagli, e il commento in `electron-builder.yml` spiega
perché. Anche esistendo, la dipendenza sarebbe una trappola invece di una comodità, perché
tirerebbe dentro proprio la versione che Regia rifiuta su ogni Ubuntu fino alla 25.10; il
pacchetto giusto non c'è. Il passo manuale resta, quindi, ed è un passo cosciente.

E c'è una trappola nuova, che questo ADR aveva già visto senza sapere dove sarebbe andata a
parare. Qui sopra si dice che l'apt di Ubuntu 24.04 dà la **0.27.0** e che coprire due formati
di configurazione è tassa pura. Su Windows la questione era teorica, perché la versione se la
sceglieva Regia. Su Linux non lo è: **`apt install snapserver` su Ubuntu 24.04 produce un
server che Regia rifiuta di avviare**, perché sotto la 0.33 la sezione `[tcp]` non si chiamava
ancora `[tcp-control]`. Il cancello di versione e il perché stanno nell'ADR 0011. Chi scriverà
le istruzioni di installazione per Linux deve saperlo prima, non dopo.

### L'obbligo GPL-3.0 resta, ma oggi non è innescato

La seconda Conseguenza — «distribuiamo un binario di snapserver dentro il nostro installer,
quindi il `.deb` va incluso non modificato, con la sua licenza e l'offerta scritta dei
sorgenti» — **vale ancora, e vale per qualunque piattaforma**: è una proprietà di cosa si
spedisce, non di che sistema operativo lo riceve.

Oggi però non si spedisce, e non per distrazione. `electron-builder.yml` ha due bersagli
Linux — AppImage e `tar.gz` — e **nessuno dei due contiene snapserver**: `extraResources`
porta soltanto `vendor/ffmpeg`, che è una build LGPL con la sua licenza accanto. Nessuno dei due
formati sa dichiarare dipendenze, e il `.deb`, che saprebbe, non è fra i bersagli. Su Windows vale lo
stesso: il binario va messo nella distro (`banco/prepara.ts` lo fa a mano per il collaudo).

Finché è così, snapserver resta un programma di sistema che Regia **esegue**, non un componente
che Regia **distribuisce**, e l'obbligo non è cancellato — è non innescato, e per una scelta
documentata invece che per un'omissione. È una differenza che conta il giorno in cui qualcuno
riapre la questione: c'è un posto dove è scritto perché.

Si riattacca **il giorno in cui uno di quei pacchetti si porta dentro il binario**, che è la
strada più ovvia per togliere di mezzo il passo manuale del paragrafo precedente. Le due cose
sono legate, ed è bene deciderle insieme: la comodità dell'installazione si paga in obblighi di
licenza. Questa correzione non la decide.

Resta invece intatta l'ultima sezione, quella sull'alternativa scartata: **implementare il
server Snapcast dentro Regia** non diventa più attraente perché è comparsa una piattaforma dove
snapserver gira nativo. Al contrario — una delle ragioni per farlo era avere un solo `.exe`, e
su Linux quel problema non esiste nemmeno.

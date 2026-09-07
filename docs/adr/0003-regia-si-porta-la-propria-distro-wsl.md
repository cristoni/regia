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

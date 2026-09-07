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

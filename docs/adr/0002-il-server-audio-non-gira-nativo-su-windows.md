# Il server audio non gira nativo su Windows

Il `CMakeLists.txt` di Snapcast definisce l'opzione di build del server solo fuori da Windows:

```cmake
if(NOT WIN32)
  option(BUILD_SERVER "Build Snapserver" ON) # no Windows server for now
endif()
```

La CI upstream compila su `windows-2022` a ogni push, con `-DWERROR=ON`, **ma solo il client**;
nessuna release ufficiale include un `snapserver.exe`. Gli errori di compilazione riportati
nell'issue #1380 (`C2146` negli header del Windows SDK) sono la conseguenza, non la causa:
non è un problema di ordine degli `#include` da sistemare, è un target che upstream ha
deciso di non supportare.

**Quindi l'opzione 1 del §4.2 del documento di progetto è chiusa.** Chi in futuro pensasse
"proviamo a compilarlo con vcpkg" sta per riaprire un port di un progetto C++ verso una
piattaforma che il progetto non supporta, e per assumersene la manutenzione a ogni
aggiornamento. Non farlo senza una ragione nuova.

## Conseguenza laterale: niente mDNS

Nello stesso file, Bonjour/avahi sono attivati solo `if(NOT WIN32 AND NOT ANDROID)`. Il §3.8.3
dà per scontato che "Snapserver già pubblica mDNS": su Windows non accadrebbe comunque, e da
dentro WSL2 in `networkingMode=mirrored` il multicast verso la LAN non è affidabile.
**Il rilevamento automatico del server da parte di Snapdroid va considerato non disponibile**:
l'indirizzo IP inserito a mano, o via QR, è l'unica strada — non un ripiego.

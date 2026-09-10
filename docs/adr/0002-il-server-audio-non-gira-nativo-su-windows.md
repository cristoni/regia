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

---

## Correzione, 10 settembre 2026

Da oggi Regia si compila e gira anche su Linux
([ADR 0011](0011-dove-gira-snapserver-e-una-sede-non-un-if.md)). Questo ADR **resta vero**, e
vale la pena dirlo esplicitamente, perché è il genere di ADR che un porting fa sembrare
superato senza che lo sia.

Il vincolo non è cambiato di una virgola: `BUILD_SERVER` è definito `if(NOT WIN32)`, quindi
snapserver **non** si compila su Windows e **sì** si compila dappertutto altrove. Riletto sul
`CMakeLists.txt` di oggi: la riga è ancora quella citata qui sopra, parola per parola.

Ciò che cambia è la **portata della conseguenza**, non la conseguenza. Il titolo dice «su
Windows», e finché Windows era l'unico bersaglio quella frase equivaleva a «dappertutto»: da
qui nascevano WSL, l'ADR 0003 e l'ADR 0010, cioè metà della complessità di rete di Regia. Ora
Windows è **un** bersaglio. Su Linux la stessa riga di CMake dice che il server gira sulla
macchina stessa, e tutto il giro che questo ADR ha reso necessario semplicemente non c'è. La
regola giusta da portarsi dietro non è «snapserver sta in una distro» ma «snapserver sta nella
Sede, e su Windows la Sede è una distro».

### Il mDNS: la conseguenza laterale va precisata

La sezione qui sopra dice «Bonjour/avahi sono attivati solo `if(NOT WIN32 AND NOT ANDROID)`»,
e la usa per concludere che il rilevamento automatico non è disponibile. Metà di quella
conclusione era una proprietà di Windows, non una proprietà di Regia, e su Linux salta:
l'opzione `BUILD_WITH_AVAHI` è dichiarata `ON` di default, e il blocco che la usa — quello che
definisce `HAS_AVAHI` e `HAS_MDNS` — sta **dentro** quel `if`. Quindi su Linux mDNS
**ci sarebbe**.

Regia tiene `mdns_enabled = false` lo stesso, e non per inerzia.

- **Perché una scoperta che funziona su metà delle macchine è peggio di una che non funziona
  mai.** Il Setup guidato è costruito sull'indirizzo scritto a mano o passato via QR — questo
  ADR l'ha deciso, e §3.8.3 è stato riscritto di conseguenza. Chi impara la procedura il
  pomeriggio su un PC Linux e poi si trova davanti quello Windows della casa scoprirebbe che il
  passo che ieri si saltava oggi è obbligatorio, e lo scoprirebbe con i visitatori dentro. La
  strada è una, ed è quella che funziona in tutti e due i casi.
- **Perché `mdns_enabled = true` non basta a sé stesso**: vuole un `avahi-daemon` acceso sulla
  macchina. Regia non lo installa e non lo verifica; dove manca, l'unico effetto è qualche riga
  di errore nel log di snapserver — cioè un guasto silenzioso al posto di una funzione.

Resta quindi vero, e per Windows e per Linux, che **il rilevamento automatico non è una strada
su cui contare**. Su Linux è per scelta invece che per impossibilità, e la differenza conta solo
il giorno in cui qualcuno vorrà riaprire il discorso: lì c'è un interruttore da girare, qui no.

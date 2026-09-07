# "Identifica" su un Altoparlante zittisce gli altri, non sposta il client

Il §4.4 suggerisce di spostare il client su uno stream "identifica" dedicato per due secondi.
Non lo facciamo: cambiare gruppo significa cambiare stream, e cambiare stream significa che il
client si ri-sincronizza da capo. Il §2.2 documenta che è **esattamente lì** che i client
Snapcast si perdono e smettono di suonare. Identifica viene usata decine di volte durante il
Setup: sarebbe ripetere di continuo la manovra che nei test rompeva l'audio.

Invece: il client non si muove mai. Regia mette in muto tutti gli **altri** client del suo
gruppo con `Client.SetVolume`, manda il suono di identificazione nello stream di quel gruppo, e
li riaccende. Nessun cambio di stream, nessuna ri-sincronizzazione, latenza pari a un `buffer`
come per qualunque altro Effetto.

## Il rischio accettato, e la protezione

I client non assegnati stanno **tutti in un unico gruppo**. A inizio Setup quel gruppo contiene
tutti i telefoni, quindi identificarne uno tocca il volume di tutti gli altri: circa 140 chiamate
RPC per dieci identificazioni, e dieci occasioni per lasciare un telefono muto se qualcosa muore
a metà sequenza. È stato considerato di dare a ogni client non assegnato un gruppo suo (Identifica
diventerebbe "manda il suono nel suo stream", senza muting), ma si è preferita l'uniformità di un
solo posto dove stanno i non assegnati.

La protezione non è il ripristino dei volumi all'avvio — un telefono rimasto muto a metà Setup
resterebbe muto per tutta la serata. È una **passata periodica di riconciliazione che ri-afferma
il volume di ogni client dai valori del file di progetto**, coerente con il principio che il file
di progetto è la verità. Un client rimasto muto per errore torna a posto da solo in pochi secondi.
In più: una sola Identifica alla volta, con stato visibile nell'interfaccia.

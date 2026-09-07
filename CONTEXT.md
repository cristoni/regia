# Regia

Applicazione Windows con cui un operatore, da un solo PC e da una stanza nascosta, guarda
le stanze di una casa degli orrori e ci fa partire dentro dei suoni al momento giusto.
Tutto su rete locale, senza internet.

## Language

### Il posto e le persone

**Regia**:
La postazione da cui l'operatore controlla l'evento — e per estensione l'applicazione stessa.
_Evita_: console, pannello di controllo, dashboard

**Operatore**:
Chi sta alla Regia durante l'evento e preme i pulsanti. Non è necessariamente una persona tecnica,
ed è diverso da chi fa il setup nel pomeriggio.
_Evita_: utente, regista

### Lo spazio

**Zona**:
Una stanza o un punto della casa, come unità di controllo: ciò che si guarda e ciò che suona
lì dentro. È il concetto attorno a cui ruota tutto il resto.
_Evita_: stanza, gruppo, canale, area

**Casa**:
L'insieme delle Zone di un evento. Da 1 a 12 Zone.
_Evita_: percorso, mappa, venue

### Il tempo

**Setup**:
Il pomeriggio prima dell'evento, quando si accendono i telefoni, si creano le Zone e si
assegnano i dispositivi. Lo fa qualcuno con competenze informatiche di base. Qui un riavvio del
server, una finestra di dialogo o due secondi di silenzio non costano nulla.
_Evita_: configurazione, installazione, preparazione

**Evento**:
Le ore in cui i visitatori attraversano la Casa. Qui non si configura più niente: nessun
riavvio, nessuna finestra bloccante, nessun silenzio. La distinzione fra Setup ed Evento decide
da sola gran parte delle scelte tecniche — quello che è gratis nel primo è vietato nel secondo.
_Evita_: spettacolo, serata, produzione, live

**Non assegnato**:
Lo stato di un Altoparlante o di una Telecamera che Regia vede, ma che non appartiene ancora a
nessuna Zona. È lo stato normale a metà Setup, non un errore.
_Evita_: orfano, libero, in attesa

### I dispositivi

**Altoparlante**:
Un telefono che fa suonare l'audio di una Zona, collegato via jack a una cassa amplificata.
Appartiene a una sola Zona.
_Evita_: dispositivo audio, client, cassa, speaker

**Telecamera**:
Un telefono che riprende una Zona. Appartiene a una sola Zona.
_Evita_: dispositivo video, cam, camera

**Telefono**:
L'oggetto fisico. Un Telefono può essere insieme Altoparlante e Telecamera: sono due ruoli
distinti, e l'appartenenza alla Zona è del ruolo, non dell'oggetto.
_Evita_: device, dispositivo

**Identifica**:
L'azione che fa manifestare fisicamente un Telefono, per capire in quale stanza si trova:
un suono breve se è un Altoparlante, un lampo di torcia se è una Telecamera. È il modo
principale con cui si abbinano i Telefoni alle Zone durante il setup.
_Evita_: ping, test, localizza, blink

### Il suono

**Suono**:
Un file audio importato nella libreria, con il suo nome, colore e volume. Termine generico:
un Suono diventa Effetto o Sottofondo a seconda di come viene usato.
_Evita_: clip, traccia, sample, file

**Effetto**:
Un Suono fatto partire dall'Operatore in una Zona, che finisce da solo. L'urlo, il botto,
la risata.
_Evita_: sparo, trigger, one-shot

**Sottofondo**:
Il Suono che gira in loop a volume basso in una Zona, sempre, per tutta la durata dell'evento.
Al massimo uno per Zona. Lo STOP di Zona non lo ferma.
_Evita_: ambiente, background, loop, musica

**Flusso**:
L'audio continuo e ininterrotto che la Regia produce per una Zona: Sottofondo ed Effetti
mescolati insieme, silenzio digitale quando non c'è nulla da suonare. Non si ferma mai finché
l'evento è in corso. Uno per Zona.
_Evita_: stream, canale, mix, uscita

## Ambiguità aperte

- **Suono vs. Effetto vs. Sottofondo** — un Suono è ciò che sta nella libreria; diventa Effetto o
  Sottofondo solo nel momento in cui una Zona lo usa. Lo stesso Suono può essere Effetto in una
  Zona e Sottofondo in un'altra. Non si dice mai "l'Effetto nella libreria".
- **Zona vs. gruppo/stream Snapcast** — "gruppo" e "stream" sono termini di Snapcast, non
  del dominio. Nel codice e nelle conversazioni si dice sempre **Zona**; "gruppo" e "stream"
  compaiono solo dove si parla letteralmente del protocollo Snapcast.

## Come si parla, in pratica

> **Sviluppatore**: Il telefono in cucina non suona più.
>
> **Esperto**: Quale, l'Altoparlante o la Telecamera? In cucina c'è un Telefono solo che fa
> tutti e due i ruoli.
>
> **Sviluppatore**: L'Altoparlante. Però la Telecamera si vede ancora.
>
> **Esperto**: Allora il Telefono è vivo ed è la connessione Snapcast che è caduta. Fai
> Identifica su quell'Altoparlante: se senti il suono, è tornato e sta nella sua Zona.
>
> **Sviluppatore**: E il Sottofondo della cucina intanto?
>
> **Esperto**: Il Flusso della Zona non si è mai fermato — il mixer ha continuato a scrivere
> anche mentre nessuno ascoltava. Appena l'Altoparlante si riconnette lo riprende a metà, non
> da capo. Non c'è niente da far ripartire.
>
> **Sviluppatore**: Se creo una Zona nuova adesso riavvio il server e cade tutto per due secondi.
>
> **Esperto**: Siamo in Setup, non me ne importa niente. Chiedimelo di nuovo alle nove di sera e
> ti rispondo di no.

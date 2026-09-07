# Ogni Zona ha un Flusso audio continuo, prodotto da un mixer nella Regia

I test sul campo hanno mostrato che un flusso Snapcast alimentato solo quando serve passa
idle→playing a ogni suono, e i client perdono la sincronia e smettono di suonare finché non
si riconnettono. Quindi la Regia scrive PCM **ininterrottamente** per ogni Zona — Sottofondo,
Effetti attivi, o silenzio digitale — e non chiude mai la sorgente mentre l'evento è in corso.

Questo è il vincolo che genera il componente più grosso del progetto: un motore di mixaggio
real-time. È deliberato. Chi legge il codice si chiederà "perché non far semplicemente partire
un file quando serve?" — perché Snapcast non lo tollera, ed è stato verificato.

## Alternative considerate

Il trasporto audio è stato rimesso in discussione una volta, perché il Flusso continuo *è*
il costo di Snapcast, e la sua latenza (il `buffer`, 500–1000 ms) è il pavimento della
latenza percepita:

- **Suoni precaricati sul telefono, comandati da un trigger** (pagina web servita dal PC, o
  app Android dedicata): latenza ~50 ms, nessun mixer, nessuna banda a riposo, niente da
  sincronizzare. Scartata: richiede software sul telefono, e la premessa del progetto è di
  usare solo le due app open source esistenti. Snapdroid in più è un foreground service
  pensato per restare vivo per ore, già provato sul campo; una pagina web in Chrome con lo
  schermo acceso in una stanza buia non lo è, né scenograficamente né tecnicamente.

Confermato Snapcast. La decisione non va riaperta: il costo è noto e accettato.

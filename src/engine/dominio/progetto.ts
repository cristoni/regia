/**
 * Il modello di dominio di Regia, e insieme lo schema del file di progetto.
 *
 * I termini seguono il glossario in CONTEXT.md: Zona, Altoparlante, Telecamera,
 * Suono, Effetto, Sottofondo, Flusso. Il dominio si scrive in italiano, la
 * meccanica in inglese.
 *
 * Gli schemi Zod sono la sola fonte di verita: i tipi TypeScript sono inferiti
 * da qui, cosi non possono divergere dalla validazione.
 *
 * Vedi ADR 0005: questo file *e* la verita. Snapcast e una proiezione.
 */
import { z } from 'zod'

/** Id assegnato da Snapcast a un client. Stabile per dispositivo. */
export const zClientId = z.string().min(1)
export const zZonaId = z.string().min(1)
export const zSuonoId = z.string().min(1)
export const zTelecameraId = z.string().min(1)

const zColore = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colore esadecimale, es. #ff6600')
/** 0 = silenzio, 1 = nominale. Sopra 1 si amplifica, con clipping controllato nel mixer. */
const zVolume = z.number().min(0).max(2)

// ---------------------------------------------------------------- Zona

export const zZona = z.object({
  id: zZonaId,
  nome: z.string().min(1).max(40),
  colore: zColore,
  /** Posizione nell'interfaccia. Non ha significato di dominio. */
  ordine: z.number().int().min(0),
  /** Volume della Zona, applicato dentro il mix e non via RPC: cosi e istantaneo. */
  volume: zVolume,
  /** Il Suono che gira in loop, sempre. Al massimo uno per Zona. */
  sottofondoId: zSuonoId.nullable(),
  /** Effetti abilitati in questa Zona. `null` significa "tutti quelli in libreria". */
  suoniAbilitati: z.array(zSuonoId).nullable(),
})
export type Zona = z.infer<typeof zZona>

// -------------------------------------------------------- Altoparlante
//
// L'appartenenza alla Zona vive QUI, sull'Altoparlante, e non come elenco
// dentro la Zona. Cosi l'invariante del glossario -- "appartiene a una sola
// Zona" -- e vera per costruzione, e non c'e uno stato doppio da tenere allineato.

export const zAltoparlante = z.object({
  /** Id Snapcast. E la chiave con cui un telefono ritrova la sua Zona dopo un riavvio. */
  id: zClientId,
  /** Nome dato dall'Operatore. Lo scriviamo anche sul server, ma la verita e qui. */
  nome: z.string().min(1).max(40),
  zonaId: zZonaId.nullable(),
  volume: zVolume,
  muto: z.boolean(),
  /**
   * Correzione di latenza in ms, per casse piu lente delle altre.
   * Snapserver la limita a `[-10000, buffer dello stream]`: con `buffer = 2000`
   * l'intervallo utile e asimmetrico.
   */
  latenzaMs: z.number().int().min(-10000).max(10000),
  /** ISO 8601. Serve al comando "dimentica" per proporre i dispositivi spariti. */
  vistoIl: z.string().datetime(),
})
export type Altoparlante = z.infer<typeof zAltoparlante>

// ----------------------------------------------------------- Telecamera

/**
 * Quanto Regia gira l'immagine di una Telecamera, in gradi **orari**
 * (ADR 0014). Lo dichiara l'Operatore in Setup: il telefono non sa dire come
 * e montato, e un telefono montato di traverso ci resta tutta la serata.
 */
export const zRotazione = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
])
export type Rotazione = z.infer<typeof zRotazione>

export const zTelecamera = z.object({
  id: zTelecameraId,
  nome: z.string().min(1).max(40),
  host: z.string().min(1),
  porta: z.number().int().min(1).max(65535),
  https: z.boolean(),
  utente: z.string().nullable(),
  /** Cifrata con DPAPI (§6). Mai in chiaro sul disco, mai nel file esportato. */
  passwordCifrata: z.string().nullable(),
  zonaId: zZonaId.nullable(),
  /**
   * Di quanto Regia gira l'immagine, in gradi orari (ADR 0014). Si applica
   * all'anteprima e alla registrazione, non al telefono.
   *
   * Ha un default, e per questo non alza `VERSIONE_PROGETTO`: un progetto
   * scritto prima che questo campo esistesse si apre senza migrazioni, con le
   * Telecamere dritte -- che e come si comportavano.
   */
  rotazione: zRotazione.default(0),
})
export type Telecamera = z.infer<typeof zTelecamera>

// ---------------------------------------------------------------- Suono

export const zSuono = z.object({
  id: zSuonoId,
  nome: z.string().min(1).max(40),
  /** Percorso relativo alla cartella suoni del progetto. */
  file: z.string().min(1),
  colore: zColore,
  categoria: z.string().max(30).nullable(),
  /** Guadagno del singolo Suono, moltiplicato per il volume di Zona nel mix. */
  guadagno: zVolume,
  durataMs: z.number().int().min(0).nullable(),
  /** Acceleratore da tastiera, es. "F1". Vale globalmente, non per Zona. */
  tastoRapido: z.string().nullable(),
  ordine: z.number().int().min(0),
})
export type Suono = z.infer<typeof zSuono>

// -------------------------------------------------------- Impostazioni

export const zImpostazioniAudio = z.object({
  /**
   * Vedi ADR 0007. Insieme ad `anticipoMs` E la latenza fra pressione e suono.
   * In snapserver e una impostazione GLOBALE: non esiste per sorgente, quindi
   * vale per tutte le Zone insieme.
   */
  bufferMs: z.number().int().min(200).max(4000),
  /** `pcm` e l'unico verificato con Snapdroid. FLAC ha fallito in silenzio. */
  codec: z.enum(['pcm', 'opus', 'flac', 'ogg']),
  frequenza: z.number().int().min(8000).max(192000),
  canali: z.union([z.literal(1), z.literal(2)]),
  /** Prima porta TCP delle sorgenti: la Zona n-esima ascolta su base + n. */
  portaBaseFlussi: z.number().int().min(1024).max(65000),
  /** Blocco di scrittura del mixer. 20 ms = 882 campioni a 44100 Hz. */
  bloccoMs: z.number().int().min(5).max(100),
  /** Dissolvenza in apertura e chiusura di ogni Effetto, contro i click. */
  dissolvenzaMs: z.number().int().min(0).max(200),
  /**
   * Quanto il mixer scrive in anticipo, per assorbire le pause del GC.
   *
   * Attenzione: **si somma a `bufferMs`**. Snapserver data i blocchi quando li
   * legge, quindi l'audio fermo nella coda della socket ritarda il proprio
   * timestamp. E un parametro di latenza, non solo di robustezza: va tenuto al
   * minimo che regge, e il minimo si misura.
   */
  anticipoMs: z.number().int().min(0).max(1000),
  /**
   * Quanto silenzio serve a snapserver per dichiarare inattivo uno stream.
   *
   * Di default vale 100 ms e il controllo scatta a `idle_threshold + chunk_ms`
   * = 120 ms: e da li che nasce il lampeggio `idle <-> playing` che nei test
   * faceva smettere di suonare i client (§2.2). Alzarlo lo cancella, gratis.
   */
  idleThresholdMs: z.number().int().min(10).max(10000),
})
export type ImpostazioniAudio = z.infer<typeof zImpostazioniAudio>

export const zImpostazioniServer = z.object({
  /** Nome della distro WSL che Regia si porta dietro (ADR 0003). */
  distro: z.string().min(1),
  portaControllo: z.number().int(),
  portaHttp: z.number().int(),
  portaFlussoClient: z.number().int(),
})
export type ImpostazioniServer = z.infer<typeof zImpostazioniServer>

export const zImpostazioniRegistrazione = z.object({
  cartella: z.string().min(1),
  minutiSegmento: z.number().int().min(1).max(120),
  conAudio: z.boolean(),
  /** Sotto questa soglia si avvisa. */
  avvisoSpazioGb: z.number().min(0),
  /** Sotto questa soglia non si registra piu. */
  bloccoSpazioGb: z.number().min(0),
})
export type ImpostazioniRegistrazione = z.infer<typeof zImpostazioniRegistrazione>

// -------------------------------------------------------------- Progetto

export const VERSIONE_PROGETTO = 1

export const zProgetto = z.object({
  versione: z.literal(VERSIONE_PROGETTO),
  nome: z.string().min(1).max(60),
  zone: z.array(zZona),
  altoparlanti: z.array(zAltoparlante),
  telecamere: z.array(zTelecamera),
  suoni: z.array(zSuono),
  audio: zImpostazioniAudio,
  server: zImpostazioniServer,
  registrazione: zImpostazioniRegistrazione,
})
export type Progetto = z.infer<typeof zProgetto>

// ---------------------------------------------------------------- Default

export function progettoVuoto(cartellaVideo: string): Progetto {
  return {
    versione: VERSIONE_PROGETTO,
    nome: 'Casa degli orrori',
    zone: [],
    altoparlanti: [],
    telecamere: [],
    suoni: [],
    audio: {
      // ADR 0007: PCM stereo 44.1k, buffer 2000. L'unica combinazione verificata sul campo.
      bufferMs: 2000,
      codec: 'pcm',
      frequenza: 44100,
      canali: 2,
      portaBaseFlussi: 4953,
      bloccoMs: 20,
      dissolvenzaMs: 15,
      anticipoMs: 200,
      idleThresholdMs: 2000,
    },
    server: {
      distro: 'Regia-Snapserver',
      portaControllo: 1705,
      portaHttp: 1780,
      portaFlussoClient: 1704,
    },
    registrazione: {
      cartella: cartellaVideo,
      minutiSegmento: 10,
      conAudio: true,
      avvisoSpazioGb: 20,
      bloccoSpazioGb: 5,
    },
  }
}

// ------------------------------------------------------------ Invarianti
//
// Cose che lo schema da solo non puo garantire. Si controllano al caricamento e
// dopo ogni modifica: un file di progetto che le viola e un file rotto, e vogliamo
// accorgercene in Setup, non a meta serata.

export type Violazione = { dove: string; problema: string }

export function violazioni(p: Progetto): Violazione[] {
  const v: Violazione[] = []
  const zone = new Set(p.zone.map((z) => z.id))
  const suoni = new Set(p.suoni.map((s) => s.id))

  const duplicati = <T>(elenco: T[], chiave: (t: T) => string, dove: string) => {
    const visti = new Set<string>()
    for (const el of elenco) {
      const k = chiave(el)
      if (visti.has(k)) v.push({ dove, problema: `id duplicato: ${k}` })
      visti.add(k)
    }
  }
  duplicati(p.zone, (z) => z.id, 'zone')
  duplicati(p.altoparlanti, (a) => a.id, 'altoparlanti')
  duplicati(p.telecamere, (t) => t.id, 'telecamere')
  duplicati(p.suoni, (s) => s.id, 'suoni')

  for (const z of p.zone) {
    if (z.sottofondoId && !suoni.has(z.sottofondoId))
      v.push({ dove: `zona ${z.nome}`, problema: `sottofondo inesistente: ${z.sottofondoId}` })
    for (const s of z.suoniAbilitati ?? [])
      if (!suoni.has(s))
        v.push({ dove: `zona ${z.nome}`, problema: `suono abilitato inesistente: ${s}` })
  }
  for (const a of p.altoparlanti)
    if (a.zonaId && !zone.has(a.zonaId))
      v.push({ dove: `altoparlante ${a.nome}`, problema: `zona inesistente: ${a.zonaId}` })
  for (const t of p.telecamere)
    if (t.zonaId && !zone.has(t.zonaId))
      v.push({ dove: `telecamera ${t.nome}`, problema: `zona inesistente: ${t.zonaId}` })

  return v
}

// ------------------------------------------------------------- Derivate

/** Le Zone in ordine di interfaccia. L'ordine determina anche le porte. */
export function zoneOrdinate(p: Progetto): Zona[] {
  return [...p.zone].sort((a, b) => a.ordine - b.ordine)
}

/** La porta della sorgente TCP di una Zona. Dipende dall'ordine, non dall'id. */
export function portaFlusso(p: Progetto, zonaId: string): number | null {
  const i = zoneOrdinate(p).findIndex((z) => z.id === zonaId)
  return i < 0 ? null : p.audio.portaBaseFlussi + i
}

/** Gli Effetti utilizzabili in una Zona: `suoniAbilitati`, oppure tutta la libreria. */
export function effettiDellaZona(p: Progetto, zona: Zona): Suono[] {
  const ammessi = zona.suoniAbilitati
  const elenco = ammessi === null ? p.suoni : p.suoni.filter((s) => ammessi.includes(s.id))
  return [...elenco].sort((a, b) => a.ordine - b.ordine)
}

/** Byte per campione per canale. Sempre 16 bit: e cio che Snapdroid accetta. */
export const BYTE_PER_CAMPIONE = 2

/** Campioni per canale in un blocco di mix. */
export function campioniBlocco(a: ImpostazioniAudio): number {
  return Math.round((a.frequenza * a.bloccoMs) / 1000)
}

/** Byte di un blocco di mix, per le allocazioni preventive del mixer. */
export function byteBlocco(a: ImpostazioniAudio): number {
  return campioniBlocco(a) * a.canali * BYTE_PER_CAMPIONE
}

/** Banda continua per Altoparlante, in bit/s. Serve agli avvisi del setup guidato. */
export function bandaPerAltoparlante(a: ImpostazioniAudio): number {
  return a.frequenza * a.canali * BYTE_PER_CAMPIONE * 8
}

/**
 * Latenza attesa fra la pressione del pulsante e il suono dagli Altoparlanti.
 * E la somma di buffer e anticipo, ed e il numero contro cui va scritto il
 * criterio di accettazione §8.3 riformulato.
 */
export function latenzaAttesaMs(a: ImpostazioniAudio): number {
  return a.bufferMs + a.anticipoMs
}

/**
 * Byte di un frame: tutti i canali di un campione. Ogni scrittura verso
 * snapserver deve essere un multiplo di questo valore, altrimenti L e R si
 * invertono **per il resto della vita della connessione** -- snapserver non ha
 * alcun concetto di frame fra una lettura e l'altra con cui riallinearsi.
 */
export function byteFrame(a: ImpostazioniAudio): number {
  return a.canali * BYTE_PER_CAMPIONE
}

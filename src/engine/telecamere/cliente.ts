/**
 * Il dialogo HTTP con una Telecamera (android-ip-camera, v0.12.0).
 *
 * Tre cose lette nel sorgente upstream che qui dentro sono legge:
 *
 *  - **`/video/h264` non accetta query string.** Con una qualsiasi, il server
 *    risponde `200 OK` in testo semplice invece dello stream. Vale per tutti gli
 *    endpoint di streaming: se serve cambiare un'impostazione si fa con una
 *    richiesta separata su `/`.
 *  - **Lo streaming va acceso** con `/control/start`, e `streaming_enabled` e
 *    persistente fra i riavvii. Come risoluzione, zoom, rotazione e torcia:
 *    restano come le ha lasciate l'ultima volta. Regia applica quindi un preset
 *    completo quando trova una Telecamera, senza fidarsi dei default.
 *  - **Il limite di client concorrenti dipende da se l'autenticazione e
 *    attiva**, non dall'esito del login. Disattivarla dimezza i limiti e
 *    accorcia la scadenza delle connessioni MJPEG da 24 ore a 30 minuti.
 */
import * as http from 'node:http'
import * as https from 'node:https'

export interface AccessoTelecamera {
  readonly host: string
  readonly porta: number
  readonly https: boolean
  readonly utente: string | null
  /** Gia decifrata. Non viene mai scritta su disco da questo modulo. */
  readonly password: string | null
}

export interface InfoTelecamera {
  readonly batteria: number | null
  readonly segnale: number | null
  readonly torcia: boolean
  readonly haFlash: boolean
  readonly risoluzione: string | null
  readonly fps: number | null
  readonly obiettivo: string | null
  readonly obiettiviDisponibili: readonly string[]
  readonly risoluzioniDisponibili: readonly string[]
  /**
   * Di quanto e montato di traverso il sensore dell'obiettivo **attivo**, in
   * gradi (`cameras[].sensorOrientation`). Sui telefoni e quasi sempre 90 o
   * 270: il sensore e coricato rispetto al verso naturale dello schermo, e
   * l'app raddrizza l'immagine -- che percio esce **verticale**. E l'unico
   * indizio che il telefono da sulla forma dell'immagine, e serve a chiedergli
   * una geometria che riempia invece di una che lasci bande nere (ADR 0014).
   */
  readonly orientamentoSensore: number | null
  readonly streamingAttivo: boolean
  /** Il nome che il telefono da di se, se lo da. Utile come nome iniziale. */
  readonly nome: string | null
}

function opzioni(a: AccessoTelecamera, percorso: string): http.RequestOptions {
  const intestazioni: Record<string, string> = { connection: 'keep-alive' }
  if (a.utente) {
    const credenziali = Buffer.from(`${a.utente}:${a.password ?? ''}`, 'utf8').toString('base64')
    intestazioni['authorization'] = `Basic ${credenziali}`
  }
  return {
    host: a.host,
    port: a.porta,
    path: percorso,
    method: 'GET',
    headers: intestazioni,
    // Il §3.3 chiede di accettare il certificato autofirmato: l'app del
    // telefono ne genera uno suo, e non c'e nessuna autorita che possa
    // firmarlo. Siamo su LAN chiusa, e l'alternativa e non usare https.
    ...(a.https ? { rejectUnauthorized: false } : {}),
  }
}

export function indirizzoDi(a: AccessoTelecamera): string {
  return `${a.https ? 'https' : 'http'}://${a.host}:${a.porta}`
}

/** Una richiesta breve che si aspetta una risposta intera e piccola. */
export function chiedi(
  a: AccessoTelecamera,
  percorso: string,
  timeoutMs = 3000,
): Promise<{ stato: number; corpo: string }> {
  return new Promise((risolvi, rifiuta) => {
    const modulo = a.https ? https : http
    const req = modulo.request(opzioni(a, percorso), (res) => {
      const pezzi: Buffer[] = []
      res.on('data', (d: Buffer) => pezzi.push(d))
      res.on('end', () =>
        risolvi({ stato: res.statusCode ?? 0, corpo: Buffer.concat(pezzi).toString('utf8') }),
      )
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('nessuna risposta')))
    req.on('error', rifiuta)
    req.end()
  })
}

export async function leggiInfo(a: AccessoTelecamera, timeoutMs = 3000): Promise<InfoTelecamera> {
  const r = await chiedi(a, '/info.json', timeoutMs)
  if (r.stato === 401) throw new Error('credenziali rifiutate dalla Telecamera')
  if (r.stato !== 200) throw new Error(`/info.json ha risposto ${r.stato}`)
  return leggiInfoDa(JSON.parse(r.corpo) as Record<string, unknown>)
}

/**
 * Traduce `/info.json` nella forma che serve a Regia.
 *
 * I campi `batteryPercent`, `wifiStrength` e `settings.{torch, deviceHasFlash,
 * streamRes, fps, cameraId}` sono **misurati** su un Pixel 10 vero. Gli elenchi
 * dei valori disponibili no: si leggono se ci sono, e se non ci sono restano
 * vuoti invece di far fallire tutto. Una Telecamera senza elenco di risoluzioni
 * resta comandabile a mano.
 */
export function leggiInfoDa(j: Record<string, unknown>): InfoTelecamera {
  const s = (j['settings'] ?? {}) as Record<string, unknown>
  const numero = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const testo = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  const elenco = (...chiavi: string[]): string[] => {
    for (const k of chiavi) {
      const v = s[k] ?? j[k]
      if (Array.isArray(v)) return v.map((x) => String(x))
    }
    return []
  }

  // L'obiettivo attivo si riconosce per `id` dentro `cameras[]`: gli altri
  // quattro del telefono hanno un sensore montato in un altro verso, e quello
  // che conta e' solo quello che sta riprendendo.
  const obiettivi = Array.isArray(j['cameras']) ? (j['cameras'] as Record<string, unknown>[]) : []
  const attivo = obiettivi.find((c) => String(c['id']) === String(s['cameraId']))

  return {
    batteria: numero(j['batteryPercent'] ?? s['batteryPercent']),
    segnale: numero(j['wifiStrength'] ?? s['wifiStrength']),
    torcia: s['torch'] === true || s['torch'] === 'on',
    haFlash: s['deviceHasFlash'] === true,
    risoluzione: testo(s['streamRes']),
    fps: numero(s['fps']),
    obiettivo: testo(s['cameraId']),
    obiettiviDisponibili: elenco('availableCameras', 'cameras', 'cameraIds'),
    risoluzioniDisponibili: elenco('availableResolutions', 'resolutions', 'streamResolutions'),
    orientamentoSensore: numero(attivo?.['sensorOrientation']),
    streamingAttivo: s['streaming_enabled'] === true || j['streaming_enabled'] === true,
    nome: testo(j['deviceName'] ?? j['name'] ?? s['deviceName']),
  }
}

/**
 * Cambia impostazioni sul telefono.
 *
 * Passano come parametri della query su `/`, cosi come sono (§3.3): Regia non
 * tiene un elenco chiuso di cio che si puo cambiare, perche l'app del telefono
 * ne aggiunge, e un elenco chiuso invecchierebbe male.
 */
export async function comanda(
  a: AccessoTelecamera,
  parametri: Readonly<Record<string, string>>,
  timeoutMs = 3000,
): Promise<void> {
  const query = Object.entries(parametri)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const r = await chiedi(a, `/?${query}`, timeoutMs)
  if (r.stato !== 200) throw new Error(`la Telecamera ha risposto ${r.stato}`)
}

/** Accende lo streaming. Persistente, ma non si da per scontato che lo sia gia. */
export async function accendiStreaming(a: AccessoTelecamera): Promise<void> {
  const r = await chiedi(a, '/control/start', 4000)
  if (r.stato !== 200) throw new Error(`/control/start ha risposto ${r.stato}`)
}

export interface FlussoAperto {
  /** Chiude la connessione verso il telefono. */
  chiudi(): void
}

/**
 * Apre l'**unica** connessione a `/video/h264` di questa Telecamera.
 *
 * Unica non per eleganza: il §4.5 vincola a una connessione per Telecamera in
 * totale, anteprima e registrazione comprese, e l'app del telefono ha un limite
 * di client concorrenti basso. I byte che escono di qui si sdoppiano nel motore
 * (ADR 0009), non aprendo una seconda connessione.
 *
 * Nessuna query string, mai: con una qualsiasi il server risponde `200 OK` in
 * testo semplice invece dello stream.
 */
/**
 * Apre `/audio`: PCM 16 bit little endian, mono, 44100 Hz.
 *
 * Due cose lo rendono diverso da una GET qualsiasi.
 *
 * **L'intestazione WAV di quell'app e malformata**: la dimensione RIFF e
 * `0x80000023` (un overflow) e quella del blocco dati `0x7FFFFFFF`. ffmpeg e
 * VLC la tollerano, altri no, e a noi non serve comunque: qui si saltano i 44
 * byte e si emettono campioni grezzi, che e cio che ffmpeg vuole con `-f
 * s16le`. Il salto va fatto **contando**, non cercando "data": i primi byte
 * possono arrivare spezzati su piu pacchetti.
 *
 * **E la seconda connessione al telefono.** L'ADR 0009 vieta di aprirne due per
 * il *video*, ed e un vincolo sul flusso video; l'audio e un endpoint diverso e
 * il §3.7 lo chiede esplicitamente. Resta pero vero che a parlare col telefono
 * e sempre e solo il motore: ffmpeg non apre mai una connessione sua.
 */
export function apriFlussoAudio(
  a: AccessoTelecamera,
  suCampioni: (d: Uint8Array) => void,
  suFine: (motivo: string) => void,
): FlussoAperto {
  const modulo = a.https ? https : http
  let chiuso = false
  let daSaltare = 44

  const fine = (motivo: string): void => {
    if (chiuso) return
    chiuso = true
    suFine(motivo)
  }

  const req = modulo.request(opzioni(a, '/audio'), (res) => {
    if (res.statusCode !== 200) {
      res.resume()
      req.destroy()
      fine(`/audio ha risposto ${res.statusCode}`)
      return
    }
    res.on('data', (d: Buffer) => {
      let pezzo = d
      if (daSaltare > 0) {
        const salta = Math.min(daSaltare, pezzo.length)
        daSaltare -= salta
        pezzo = pezzo.subarray(salta)
        if (pezzo.length === 0) return
      }
      suCampioni(pezzo)
    })
    res.on('end', () => fine('il telefono ha chiuso l audio'))
    res.on('error', (e) => fine(e.message))
  })

  req.setTimeout(6000, () => req.destroy(new Error('silenzio dal telefono')))
  req.on('error', (e) => fine(e.message))
  req.end()

  return {
    chiudi() {
      chiuso = true
      req.destroy()
    },
  }
}

export function apriFlussoH264(
  a: AccessoTelecamera,
  suDati: (d: Uint8Array) => void,
  suFine: (motivo: string) => void,
): FlussoAperto {
  const modulo = a.https ? https : http
  let chiuso = false

  const fine = (motivo: string): void => {
    if (chiuso) return
    chiuso = true
    suFine(motivo)
  }

  const req = modulo.request(opzioni(a, '/video/h264'), (res) => {
    if (res.statusCode !== 200) {
      res.resume()
      req.destroy()
      fine(`/video/h264 ha risposto ${res.statusCode}`)
      return
    }
    // Il flusso non finisce mai da solo: il timeout serve solo ad accorgersi
    // che il telefono ha smesso di mandare, non a chiudere una richiesta lunga.
    res.on('data', (d: Buffer) => suDati(d))
    res.on('end', () => fine('il telefono ha chiuso il flusso'))
    res.on('error', (e) => fine(e.message))
  })

  // Un secondo e mezzo senza un byte, con un fotogramma chiave ogni secondo
  // e venti fotogrammi al secondo, significa che il telefono non c'e piu.
  req.setTimeout(6000, () => req.destroy(new Error('silenzio dal telefono')))
  req.on('error', (e) => fine(e.message))
  req.end()

  return {
    chiudi() {
      chiuso = true
      req.destroy()
    },
  }
}

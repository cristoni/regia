/**
 * La registrazione video: ffmpeg che impacchetta i byte gia in casa.
 *
 * **ffmpeg non contatta mai il telefono** (ADR 0009). I byte arrivano
 * dall'unica connessione a `/video/h264` che il gestore delle Telecamere tiene
 * aperta, e qui si limitano a finire nello stdin di un ffmpeg con `-c:v copy`:
 * nessuna ricodifica del video, e a parlare col telefono e sempre e solo il
 * motore.
 *
 * Con l'audio acceso (§3.7) il telefono riceve una seconda connessione, su
 * `/audio`: la apre il gestore delle Telecamere, non ffmpeg. Quei campioni non
 * arrivano pero direttamente al secondo ingresso -- ci sta in mezzo la
 * `PompaAudio`, e la ragione e nel suo file: un ingresso che tace blocca
 * ffmpeg, e accendere l'audio non deve poter far perdere il video.
 *
 * Tre vincoli misurati che sembrano dettagli:
 *
 *  - **Il binario dev'essere quello in bundle.** L'`ffmpeg` del PATH puo essere
 *    uno shim che lancia il vero ffmpeg come figlio: `kill()` uccide lo shim e
 *    lascia il vero ffmpeg orfano, che continua a scrivere su un file che Regia
 *    crede chiuso.
 *  - **Si chiude con `stdin.end()`, mai con `kill()`**, o il `moov` non viene
 *    scritto e il file non si apre. Il §8.6 chiede che si aprano in VLC e in
 *    Windows Media Player.
 *  - **Niente `-r` sull'input**: forza il CFR e sbaglia la durata quando la
 *    sorgente devia dal nominale (verificato: 20 secondi reali diventati un file
 *    da 8).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { Progetto } from '../dominio/progetto.js'
import type { Livello } from '../api/protocollo.js'
import { trovaFfmpeg } from '../media/ffmpeg.js'
import { CANALI_AUDIO, FREQUENZA_AUDIO, PompaAudio } from './pompa-audio.js'
import { MuxTs } from './ts.js'
import type { GestoreTelecamere } from '../telecamere/gestore.js'

export interface OpzioniRegistratore {
  readonly progetto: () => Progetto
  readonly suDiario: (livello: Livello, testo: string) => void
  readonly telecamere: GestoreTelecamere
}

export interface FileRegistrato {
  readonly nome: string
  readonly byte: number
  readonly quando: string
}

export interface StatoRegistratore {
  /** Gli identificativi delle Telecamere che stanno registrando. */
  readonly telecamere: readonly string[]
  readonly spazioLiberoGb: number
}

interface InCorso {
  ffmpeg: ChildProcessWithoutNullStreams | null
  /**
   * Il muxer che da' un PTS nostro a ogni fotogramma prima di ffmpeg. Uno per
   * ffmpeg: una ripresa fa un ffmpeg nuovo, quindi un muxer nuovo (che riparte
   * dallo zero della sua linea temporale). Vedi `ts.ts`.
   */
  mux: MuxTs | null
  stacca: () => void
  /** Vero mentre si aspetta che il telefono torni: REC resta acceso (§3.7). */
  inAttesa: boolean
  chiudendo: boolean
  /** La pompa del secondo ingresso, se si registra anche l'audio. */
  pompa: PompaAudio | null
  /** La porta su cui ffmpeg va a prendersi l'audio. */
  portaAudio: number | null
  /** Chiude `/audio` sul telefono. */
  staccaAudio: () => void
}

/** Ogni quanto si ricontrolla lo spazio libero. */
const CADENZA_SPAZIO_MS = 10_000

/**
 * Le lamentele che ffmpeg fa quando entra in un flusso H.264 gia cominciato, e
 * che smettono da sole al primo fotogramma chiave. Misurato: una ventina di
 * righe per avvio, identiche con l'ingresso grezzo di prima e con l'MPEG-TS di
 * adesso. Nel Diario -- che il §3.10 vuole leggibile dall'Operatore --
 * sarebbero venti allarmi su cui non c'e niente da fare, mescolati a quello
 * vero.
 *
 * Da quando il `MuxTs` trattiene tutto fino al primo fotogramma chiave, a
 * ffmpeg un flusso preso a meta non arriva piu e queste righe non dovrebbero
 * comparire. Il filtro resta: costa una regex, e se un giorno il trattenimento
 * cambiasse il Diario non deve tornare a riempirsi.
 */
const RUMORE_DI_AVVIO = /non-existing PPS|decode_slice_header error|no frame!|Last message repeated/

export class Registratore {
  private readonly attive = new Map<string, InCorso>()
  private spazioGb = 0
  private battito: NodeJS.Timeout | null = null

  constructor(private readonly opzioni: OpzioniRegistratore) {}

  avvia(): void {
    if (this.battito) return
    this.battito = setInterval(() => void this.misuraSpazio(), CADENZA_SPAZIO_MS)
    this.battito.unref?.()
    void this.misuraSpazio()
  }

  stato(): StatoRegistratore {
    return { telecamere: [...this.attive.keys()], spazioLiberoGb: this.spazioGb }
  }

  // ------------------------------------------------------------- comandi

  async accendi(telecameraId: string): Promise<void> {
    if (this.attive.has(telecameraId)) return

    const p = this.opzioni.progetto()
    const t = p.telecamere.find((x) => x.id === telecameraId)
    if (!t) throw new Error(`Telecamera inesistente: ${telecameraId}`)

    const ff = trovaFfmpeg()
    if (!ff) {
      throw new Error('ffmpeg non trovato: la registrazione ha bisogno del binario in bundle')
    }
    await this.misuraSpazio()
    if (this.spazioGb > 0 && this.spazioGb < p.registrazione.bloccoSpazioGb) {
      throw new Error(
        `spazio su disco insufficiente (${this.spazioGb.toFixed(1)} GB): la registrazione e bloccata`,
      )
    }
    if (!ff.inBundle) {
      this.opzioni.suDiario(
        'attenzione',
        'ffmpeg viene dal PATH e non dal bundle: se e uno shim, fermare la registrazione ' +
          'potrebbe lasciare un processo orfano.',
      )
    }

    await fs.mkdir(p.registrazione.cartella, { recursive: true })

    const inCorso: InCorso = {
      ffmpeg: null,
      mux: null,
      stacca: () => {},
      inAttesa: false,
      chiudendo: false,
      pompa: null,
      portaAudio: null,
      staccaAudio: () => {},
    }

    // La pompa si apre **prima** di ffmpeg: ffmpeg si collega a lei appena
    // parte, e se non trovasse nessuno in ascolto morirebbe subito portandosi
    // via anche il video.
    if (p.registrazione.conAudio) {
      try {
        const pompa = new PompaAudio()
        const porta = await pompa.apri()
        inCorso.pompa = pompa
        inCorso.portaAudio = porta
        inCorso.staccaAudio = this.opzioni.telecamere.apriAudio(telecameraId, {
          byte: (d) => pompa.campioni(d),
          caduto: (motivo) => {
            // Non e un motivo per fermare la registrazione: la pompa continua a
            // scrivere silenzio e il video prosegue. Se sparisce anche il
            // video, se ne accorge l'altro ascoltatore.
            this.opzioni.suDiario(
              'attenzione',
              `Audio di "${t.nome}" interrotto (${motivo}): il video continua, la traccia prosegue in silenzio.`,
            )
          },
        })
      } catch (e) {
        // Meglio registrare senza audio che non registrare: il §3.7 chiede il
        // video, l'audio e un'opzione.
        //
        // ⚠️ Si azzera ANCHE `portaAudio` e si chiude la pompa: senza,
        // `portaAudio` restava impostata, ffmpeg partiva con `-map 1:a` verso
        // una pompa che ascolta ma non parte mai, si bloccava sull'ingresso
        // muto, veniva ucciso dopo 5 s e lasciava un MP4 senza `moov` --
        // illeggibile -- piu' un server della pompa mai chiuso.
        await inCorso.pompa?.chiudi().catch(() => {})
        inCorso.pompa = null
        inCorso.portaAudio = null
        this.opzioni.suDiario(
          'attenzione',
          `Non sono riuscito ad aprire l'audio di "${t.nome}" (${(e as Error).message}). Registro solo il video.`,
        )
      }
    }

    this.attive.set(telecameraId, inCorso)

    inCorso.stacca = this.opzioni.telecamere.ascoltaByte(telecameraId, {
      byte: (d) => {
        if (inCorso.chiudendo) return
        // La ripresa dopo una caduta si riconosce dai byte che ricominciano ad
        // arrivare: il gestore delle Telecamere non manda un avviso di ripresa,
        // e non ne serve uno -- questo *e* l'avviso.
        if (!inCorso.ffmpeg && inCorso.inAttesa) {
          this.apriFfmpeg(telecameraId, inCorso)
          this.opzioni.suDiario('info', `Registrazione di "${t.nome}" ripresa su un file nuovo.`)
        }
        const f = inCorso.ffmpeg
        if (!f || f.stdin.destroyed || !inCorso.mux) return
        // I byte grezzi H.264 passano dal muxer, che trattiene tutto fino al
        // primo fotogramma chiave e poi impacchetta ogni unita di accesso in
        // MPEG-TS con un PTS nostro. E' lui a scrivere sullo stdin di ffmpeg
        // (via il callback impostato in apriFfmpeg) -- ed e li, alla prima
        // emissione, che parte anche la pompa dell'audio: i due zeri devono
        // coincidere.
        inCorso.mux.spingi(d)
      },
      caduto: (motivo) => {
        if (inCorso.chiudendo) return
        // Il file si chiude bene e resta leggibile; REC resta acceso e riparte
        // su un file nuovo quando il telefono torna. E alla lettera il §3.7.
        this.opzioni.suDiario(
          'attenzione',
          `Registrazione di "${t.nome}" interrotta (${motivo}): chiudo il file, riprendo appena torna.`,
        )
        this.chiudiFfmpeg(inCorso)
        inCorso.inAttesa = true
      },
    })

    this.apriFfmpeg(telecameraId, inCorso)
    this.opzioni.suDiario('info', `REC acceso su "${t.nome}".`)
  }

  async spegni(telecameraId: string): Promise<void> {
    const inCorso = this.attive.get(telecameraId)
    if (!inCorso) return
    this.attive.delete(telecameraId)
    inCorso.chiudendo = true
    inCorso.stacca()
    inCorso.staccaAudio()
    await this.chiudiFfmpeg(inCorso)
    if (inCorso.pompa) {
      const silenzio = Math.round(inCorso.pompa.silenzioInventatoMs / 1000)
      await inCorso.pompa.chiudi()
      if (silenzio > 1) {
        this.opzioni.suDiario(
          'info',
          `Nella traccia audio ci sono ${silenzio} s di silenzio: tanto e mancato dal telefono.`,
        )
      }
    }
    const t = this.opzioni.progetto().telecamere.find((x) => x.id === telecameraId)
    this.opzioni.suDiario('info', `REC spento su "${t?.nome ?? telecameraId}".`)
  }

  /** Le Telecamere di una Zona, o tutte. Un guasto su una non ferma le altre. */
  async accendiMolte(ids: readonly string[]): Promise<void> {
    const errori: string[] = []
    for (const id of ids) {
      try {
        await this.accendi(id)
      } catch (e) {
        errori.push((e as Error).message)
      }
    }
    if (errori.length > 0 && errori.length === ids.length) throw new Error(errori[0]!)
    for (const e of errori) this.opzioni.suDiario('attenzione', e)
  }

  async spegniMolte(ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.spegni(id)
  }

  async chiudi(): Promise<void> {
    if (this.battito) clearInterval(this.battito)
    this.battito = null
    for (const id of [...this.attive.keys()]) await this.spegni(id)
  }

  /** L'elenco dei file registrati, per la schermata Registrazioni (§3.7). */
  async elenco(): Promise<FileRegistrato[]> {
    const cartella = this.opzioni.progetto().registrazione.cartella
    let nomi: string[]
    try {
      nomi = await fs.readdir(cartella)
    } catch {
      return []
    }
    const fuori: FileRegistrato[] = []
    for (const nome of nomi) {
      if (!/\.(mp4|mkv)$/i.test(nome)) continue
      try {
        const s = await fs.stat(path.join(cartella, nome))
        fuori.push({ nome, byte: s.size, quando: s.mtime.toISOString() })
      } catch {
        /* sparito fra readdir e stat: succede, non e un errore */
      }
    }
    return fuori.sort((a, b) => b.quando.localeCompare(a.quando))
  }

  // ------------------------------------------------------------- interni

  private apriFfmpeg(telecameraId: string, inCorso: InCorso): void {
    const p = this.opzioni.progetto()
    const t = p.telecamere.find((x) => x.id === telecameraId)
    if (!t) return
    const ff = trovaFfmpeg()
    if (!ff) return

    const zona = p.zone.find((z) => z.id === t.zonaId)
    const modello = path.join(
      p.registrazione.cartella,
      `${pulisci(zona?.nome ?? 'senza-zona')}_${pulisci(t.nome)}_%Y%m%d_%H%M%S.mp4`,
    )

    const argomenti = [
      '-hide_banner',
      '-loglevel', 'warning',
      // Il video arriva gia' come MPEG-TS con i PTS che ha messo Regia (`MuxTs`),
      // NON come H.264 grezzo con `-use_wallclock_as_timestamps`. Quel percorso
      // faceva timbrare a ffmpeg l'ora di lettura: con l'ingresso audio accanto,
      // il muxer affamava il lettore video (DTS all'epoch contro DTS audio da
      // ~0) e il girato diventava una diapositiva + avanti-veloce. Con i PTS
      // vicini allo zero, nello stesso intervallo dell'audio, l'interleave
      // funziona. Misurato il 2026-09-11; vedi ts.ts e docs/fatti-verificati.md.
      '-f', 'mpegts',
      '-i', 'pipe:0',
      // Il secondo ingresso e la pompa, non il telefono: ffmpeg si collega a
      // una socket che Regia serve, e da li escono campioni **sempre**, anche
      // quando il telefono tace. Un ingresso che si ferma bloccherebbe anche
      // la scrittura del video.
      ...(inCorso.portaAudio === null
        ? []
        : [
            '-f', 's16le',
            '-ar', String(FREQUENZA_AUDIO),
            '-ac', String(CANALI_AUDIO),
            '-i', `tcp://127.0.0.1:${inCorso.portaAudio}`,
            '-map', '0:v',
            '-map', '1:a',
          ]),
      // Il video non si ricodifica mai (§3.7). L'audio si', perche il PCM
      // grezzo in un MP4 non e riproducibile ovunque e pesa dieci volte tanto.
      '-c:v', 'copy',
      ...(inCorso.portaAudio === null ? [] : ['-c:a', 'aac', '-b:a', '96k']),
      '-fps_mode', 'passthrough',
      // La suddivisione la fa ffmpeg: ogni segmento si chiude da solo e resta
      // leggibile, e un crash costa al massimo un segmento (§3.7).
      '-f', 'segment',
      '-segment_time', String(p.registrazione.minutiSegmento * 60),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-strftime', '1',
      modello,
    ]

    const f = spawn(ff.percorso, argomenti, { windowsHide: true })
    inCorso.ffmpeg = f
    // Un muxer nuovo per questo ffmpeg: la sua linea temporale riparte da zero,
    // e i pacchetti TS che produce vanno nello stdin di *questo* processo.
    // Contropressione ignorata di proposito, come per il video grezzo di prima:
    // la sorgente e' un telefono a ~1,5 Mbit/s verso un disco locale.
    //
    // La pompa dell'audio parte QUI, alla prima emissione del muxer, non al
    // primo byte grezzo: il muxer trattiene tutto fino al primo fotogramma
    // chiave, e se l'audio partisse prima il suo zero starebbe fino a un GOP
    // avanti a quello del video -- audio in ritardo per tutta la ripresa.
    inCorso.mux = new MuxTs({
      scrivi: (ts) => {
        inCorso.pompa?.avvia()
        if (!f.stdin.destroyed) f.stdin.write(Buffer.from(ts))
      },
    })
    inCorso.inAttesa = false

    // Lo stderr di ffmpeg arriva a pezzi che non coincidono con le righe: senza
    // ricomporlo il Diario si riempie di mezze parole ("Last message repeated 1
    // tim" / "es"). Si accumula e si taglia sui ritorni a capo.
    let resto = ''
    let scartate = 0
    f.stderr.on('data', (d: Buffer) => {
      resto += d.toString('utf8')
      const righe = resto.split(/\r?\n/)
      resto = righe.pop() ?? ''
      for (const riga of righe) {
        const testo = riga.trim()
        if (!testo) continue
        if (RUMORE_DI_AVVIO.test(testo)) {
          scartate++
          continue
        }
        this.opzioni.suDiario('attenzione', `ffmpeg (${t.nome}): ${testo.slice(0, 200)}`)
      }
    })
    f.on('close', () => {
      if (scartate === 0) return
      // Non e un guasto e non c'e niente da fare: ffmpeg entra nel flusso a
      // meta e si lamenta finche non arriva il primo fotogramma chiave, che
      // sul telefono arriva entro un secondo. Una riga sola, per dire che e
      // successo e che e finito.
      this.opzioni.suDiario(
        'info',
        `Registrazione di "${t.nome}": ${scartate} righe di ffmpeg prima del primo ` +
          'fotogramma chiave, normali su un flusso preso a meta.',
      )
    })
    f.stdin.on('error', () => {
      /* lo stdin si chiude quando ffmpeg esce: non e un guasto */
    })
    f.on('error', (e) => {
      this.opzioni.suDiario('grave', `ffmpeg non e partito per "${t.nome}": ${e.message}`)
      inCorso.ffmpeg = null
    })
    f.on('exit', (codice) => {
      if (inCorso.ffmpeg === f) inCorso.ffmpeg = null
      if (codice !== 0 && !inCorso.chiudendo) {
        this.opzioni.suDiario('attenzione', `ffmpeg per "${t.nome}" e uscito con ${codice}.`)
      }
      // Se la registrazione e ancora accesa e non stiamo chiudendo, il flusso
      // tornera e con lui i byte: si riapre allora, non adesso.
      if (this.attive.get(telecameraId) === inCorso && !inCorso.chiudendo) inCorso.inAttesa = true
    })
  }

  /**
   * Chiude ffmpeg **bene**: stdin, e poi si aspetta che esca da solo.
   *
   * `kill()` lascerebbe un MP4 senza `moov`, cioe un file che nessun lettore
   * apre. Se dopo cinque secondi non e uscito lo si ammazza comunque, ma quel
   * file e da considerarsi perso e lo si dice.
   */
  private chiudiFfmpeg(inCorso: InCorso): Promise<void> {
    const f = inCorso.ffmpeg
    inCorso.ffmpeg = null
    // Il muxer butta l'ultima unita incompleta (non e un fotogramma) e si
    // chiude con questo ffmpeg: il prossimo ne avra' uno nuovo, dallo zero.
    inCorso.mux?.chiudi()
    inCorso.mux = null
    // Prima si chiude il secondo ingresso, poi si aspetta: ffmpeg esce quando
    // finiscono tutti i suoi ingressi, non solo lo stdin. Misurato: senza
    // questa riga non usciva mai, lo si ammazzava dopo cinque secondi e il
    // file restava senza `moov`.
    inCorso.pompa?.staccaFfmpeg()
    if (!f) return Promise.resolve()

    return new Promise<void>((ok) => {
      const scadenza = setTimeout(() => {
        this.opzioni.suDiario(
          'grave',
          'ffmpeg non si e chiuso da solo: il file potrebbe non essere leggibile.',
        )
        f.kill()
        ok()
      }, 5000)
      scadenza.unref?.()
      f.once('exit', () => {
        clearTimeout(scadenza)
        ok()
      })
      if (!f.stdin.destroyed) f.stdin.end()
    })
  }

  private async misuraSpazio(): Promise<void> {
    const cartella = this.opzioni.progetto().registrazione.cartella
    try {
      const s = await fs.statfs(cartella)
      this.spazioGb = (s.bavail * s.bsize) / 1e9
    } catch {
      // La cartella potrebbe non esistere ancora: si guarda quella sopra.
      try {
        const s = await fs.statfs(path.parse(cartella).root)
        this.spazioGb = (s.bavail * s.bsize) / 1e9
      } catch {
        this.spazioGb = 0
      }
    }
  }
}

/** Un nome di Zona o di Telecamera dentro un nome di file. */
function pulisci(nome: string): string {
  return nome.replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, '-').slice(0, 30) || 'senza-nome'
}

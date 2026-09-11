/**
 * La libreria dei Suoni.
 *
 * Il §3.4 chiede che la riproduzione sia istantanea. Un MP3 non lo e: va
 * decodificato. Quindi ogni Suono viene convertito UNA volta, alla prima
 * importazione, nel formato esatto del progetto (PCM interleaved, 16 bit), e
 * tenuto in cache su disco. All'avvio e il **thread audio** a caricarsela in
 * memoria, direttamente dal file: da questa classe escono percorsi e durate,
 * mai campioni -- il thread principale non ne tiene nemmeno uno.
 *
 * La chiave di cache contiene il formato audio: cambiare frequenza o canali
 * nelle impostazioni invalida tutto da solo, senza che nessuno debba ricordarsi
 * di svuotare niente.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { BYTE_PER_CAMPIONE, type ImpostazioniAudio, type Suono } from '../dominio/progetto.js'

export class ErroreDecodifica extends Error {
  constructor(
    readonly file: string,
    readonly dettaglio: string,
  ) {
    super(`non riesco a decodificare "${path.basename(file)}": ${dettaglio}`)
    this.name = 'ErroreDecodifica'
  }
}

export class LibreriaSuoni {
  constructor(
    /** Dove stanno i file originali importati dall'utente. */
    private readonly cartellaSuoni: string,
    /** Dove stanno i .pcm derivati. Cancellabile in qualunque momento. */
    private readonly cartellaCache: string,
    private readonly ffmpeg = 'ffmpeg',
  ) {}

  /**
   * Copia un file scelto dall'utente dentro la cartella del progetto. Il nome
   * viene reso univoco: due file diversi con lo stesso nome non si sovrascrivono.
   */
  async importa(fileEsterno: string): Promise<string> {
    const dati = await fs.readFile(fileEsterno)
    const impronta = createHash('sha1').update(dati).digest('hex').slice(0, 8)
    const est = path.extname(fileEsterno).toLowerCase()
    const base = path.basename(fileEsterno, path.extname(fileEsterno)).replace(/[^\w\- ]+/g, '_')
    const nome = `${base}-${impronta}${est}`

    await fs.mkdir(this.cartellaSuoni, { recursive: true })
    await fs.writeFile(path.join(this.cartellaSuoni, nome), dati)
    return nome
  }

  /**
   * Garantisce che il `.pcm` esista, e ne restituisce il percorso -- **senza
   * caricarlo in memoria**.
   *
   * E la strada normale: i campioni li legge il thread audio, direttamente da
   * qui. Un Sottofondo da tre minuti sono 31 MB, e il thread principale non ha
   * nessuna ragione di tenerseli.
   */
  async assicura(
    suono: Suono,
    audio: ImpostazioniAudio,
  ): Promise<{ percorso: string; durataMs: number; convertito: boolean }> {
    const sorgente = path.join(this.cartellaSuoni, suono.file)
    const chiave = await this.chiaveCache(sorgente, audio)
    const percorso = path.join(this.cartellaCache, `${chiave}.pcm`)

    let byte = await this.misuraSeEsiste(percorso)
    let convertito = false
    if (byte === null) {
      await fs.mkdir(this.cartellaCache, { recursive: true })
      byte = await this.decodifica(sorgente, audio, percorso)
      convertito = true
    }

    const bytePerSecondo = audio.frequenza * audio.canali * BYTE_PER_CAMPIONE
    return { percorso, durataMs: Math.round((byte / bytePerSecondo) * 1000), convertito }
  }

  /** Come `assicura`, per tutta la libreria. Un file rotto non ferma gli altri. */
  async assicuraTutti(
    suoni: readonly Suono[],
    audio: ImpostazioniAudio,
  ): Promise<{
    pronti: Array<{ suono: Suono; percorso: string; durataMs: number }>
    errori: ErroreDecodifica[]
  }> {
    const pronti: Array<{ suono: Suono; percorso: string; durataMs: number }> = []
    const errori: ErroreDecodifica[] = []
    for (const suono of suoni) {
      try {
        const { percorso, durataMs } = await this.assicura(suono, audio)
        pronti.push({ suono, percorso, durataMs })
      } catch (e) {
        errori.push(e instanceof ErroreDecodifica ? e : new ErroreDecodifica(suono.file, String(e)))
      }
    }
    return { pronti, errori }
  }

  // ------------------------------------------------------------- interni

  private async chiaveCache(sorgente: string, audio: ImpostazioniAudio): Promise<string> {
    const dati = await fs.readFile(sorgente)
    return createHash('sha1')
      .update(dati)
      .update(`|${audio.frequenza}|${audio.canali}|s16le`)
      .digest('hex')
  }

  /** Byte del file in cache, o `null` se non c'e. Non lo legge. */
  private async misuraSeEsiste(p: string): Promise<number | null> {
    try {
      const s = await fs.stat(p)
      return s.size > 0 ? s.size : null
    } catch {
      return null
    }
  }

  /** Converte e restituisce i **byte scritti**: i campioni non passano di qui. */
  private async decodifica(
    sorgente: string,
    audio: ImpostazioniAudio,
    destinazione: string,
  ): Promise<number> {
    // Si scrive su un file temporaneo e si rinomina: una conversione interrotta
    // non deve lasciare in cache un .pcm troncato che poi verrebbe creduto buono.
    const temporaneo = destinazione + '.tmp'
    const argomenti = [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-i', sorgente,
      '-map', 'a:0',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ar', String(audio.frequenza),
      '-ac', String(audio.canali),
      '-y', temporaneo,
    ]

    await new Promise<void>((risolvi, rifiuta) => {
      const p = spawn(this.ffmpeg, argomenti, { windowsHide: true })
      let errori = ''
      p.stderr.on('data', (d: Buffer) => {
        errori += d.toString()
      })
      p.on('error', (e) =>
        rifiuta(
          new ErroreDecodifica(
            sorgente,
            e.message.includes('ENOENT') ? 'ffmpeg non trovato' : e.message,
          ),
        ),
      )
      p.on('close', (codice) => {
        if (codice === 0) risolvi()
        else rifiuta(new ErroreDecodifica(sorgente, errori.trim() || `ffmpeg uscito con ${codice}`))
      })
    }).catch(async (e) => {
      await fs.rm(temporaneo, { force: true })
      throw e
    })

    // Si misura senza leggere: un Sottofondo da tre minuti sono 31 MB di PCM,
    // e non c'e nessuna ragione di farli passare per il thread principale.
    const scritto = await fs.stat(temporaneo)
    if (scritto.size === 0) {
      await fs.rm(temporaneo, { force: true })
      throw new ErroreDecodifica(sorgente, 'il file non contiene audio')
    }
    await fs.rename(temporaneo, destinazione)
    return scritto.size
  }
}

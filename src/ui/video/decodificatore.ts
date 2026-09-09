/**
 * Un fotogramma H.264 alla volta, dal WebSocket alla `<canvas>`.
 *
 * Usa `VideoDecoder` di WebCodecs, cioe il decoder hardware della GPU: e il
 * percorso video piu economico possibile, ed e identico in Electron e in un
 * browser (ADR 0004). Sei celle a 720x480 costano quasi solo memoria video.
 *
 * Due cose che, sbagliate, non danno errore e basta:
 *
 *  - **Per Annex-B il campo `description` va omesso.** La sua presenza non e
 *    opzionale: e il selettore che commuta il decoder in modalita avcC, dove i
 *    codici di avvio `00 00 01` vengono letti come lunghezze. Il decoder non
 *    protesta, semplicemente non produce niente.
 *  - **La stringa del codec si ricava dall'SPS**, non si indovina. Un Pixel
 *    puo emettere baseline o high a seconda della risoluzione, e una stringa
 *    che non corrisponde fa fallire `configure` su alcune GPU e non su altre --
 *    cioe funziona sul PC di chi sviluppa e non su quello dell'evento.
 *
 * I timestamp sono un contatore a fps nominale, e va bene che lo siano: in
 * WebCodecs sono inerti e non governano la resa. E deliberatamente un modello
 * del tempo diverso da quello della registrazione, dove a datare e ffmpeg.
 */

/** Il fps nominale della Telecamera. Serve solo a numerare i chunk. */
const FPS_NOMINALE = 20

export class DecodificatoreVideo {
  private decoder: VideoDecoder | null = null
  private contesto: CanvasRenderingContext2D | null
  private prossimoTimestamp = 0
  /** Finche non arriva un fotogramma chiave non si puo decodificare niente. */
  private avviato = false
  private chiuso = false

  constructor(
    private readonly tela: HTMLCanvasElement,
    private readonly suErrore: (testo: string) => void,
  ) {
    this.contesto = tela.getContext('2d', { alpha: false })
  }

  static get disponibile(): boolean {
    return typeof VideoDecoder !== 'undefined'
  }

  fotogramma(chiave: boolean, dati: Uint8Array): void {
    if (this.chiuso) return
    if (!DecodificatoreVideo.disponibile) {
      this.suErrore('questo browser non ha WebCodecs')
      this.chiuso = true
      return
    }

    if (!this.decoder) {
      if (!chiave) return
      const codec = codecDaSps(dati)
      if (!codec) return
      if (!this.configura(codec)) return
    }
    // Un decoder che si e appena aperto, o che si e ripreso da un errore, deve
    // ripartire da un fotogramma chiave: darle un differenziale produce
    // artefatti verdi finche non arriva il prossimo IDR.
    if (!this.avviato) {
      if (!chiave) return
      this.avviato = true
    }

    try {
      this.decoder!.decode(
        new EncodedVideoChunk({
          type: chiave ? 'key' : 'delta',
          timestamp: this.prossimoTimestamp,
          data: dati,
        }),
      )
      this.prossimoTimestamp += Math.round(1e6 / FPS_NOMINALE)
    } catch (e) {
      this.riprendi((e as Error).message)
    }
  }

  chiudi(): void {
    this.chiuso = true
    this.smonta()
    this.contesto = null
  }

  // -------------------------------------------------------------- interni

  private configura(codec: string): boolean {
    try {
      const decoder = new VideoDecoder({
        output: (fotogramma) => this.disegna(fotogramma),
        error: (e) => this.riprendi(e.message),
      })
      decoder.configure({
        codec,
        // Niente `description`: e Annex-B, e la sua presenza commuterebbe il
        // decoder in modalita avcC.
        optimizeForLatency: true,
      })
      this.decoder = decoder
      return true
    } catch (e) {
      this.suErrore(`decoder non configurabile (${codec}): ${(e as Error).message}`)
      this.chiuso = true
      return false
    }
  }

  private disegna(fotogramma: VideoFrame): void {
    const c = this.contesto
    if (!c || this.chiuso) {
      fotogramma.close()
      return
    }
    // La tela si ridimensiona solo quando la risoluzione cambia davvero:
    // riassegnare `width` la ripulisce e fa lampeggiare la cella.
    if (this.tela.width !== fotogramma.displayWidth) this.tela.width = fotogramma.displayWidth
    if (this.tela.height !== fotogramma.displayHeight) this.tela.height = fotogramma.displayHeight
    c.drawImage(fotogramma, 0, 0)
    // `close()` **deve** essere chiamato: un `VideoFrame` tiene un buffer della
    // GPU, e dimenticarne uno per fotogramma esaurisce la memoria video in
    // pochi minuti. Non basta lasciarlo al garbage collector.
    fotogramma.close()
  }

  /**
   * Un errore del decoder non e la fine: si butta via e si riparte dal prossimo
   * fotogramma chiave, che arriva entro un secondo. Chiudere la cella per un
   * pacchetto storto sarebbe peggio del pacchetto storto.
   */
  private riprendi(motivo: string): void {
    if (this.chiuso) return
    this.smonta()
    this.avviato = false
    this.suErrore(motivo)
  }

  private smonta(): void {
    const d = this.decoder
    this.decoder = null
    if (!d) return
    try {
      if (d.state !== 'closed') d.close()
    } catch {
      /* gia chiuso */
    }
  }
}

/**
 * La stringa del codec, letta dall'SPS dentro l'unita di accesso chiave.
 *
 * `avc1.PPCCLL`: profilo, flag di vincolo, livello, in esadecimale. Sono i tre
 * byte subito dopo l'intestazione della NAL di tipo 7, e sono li apposta --
 * e la stessa terna che finisce nel `codecs=` di un MP4.
 */
export function codecDaSps(unita: Uint8Array): string | null {
  for (let i = 0; i + 3 < unita.length; i++) {
    if (unita[i] !== 0 || unita[i + 1] !== 0) continue
    let testa: number
    if (unita[i + 2] === 1) testa = i + 3
    else if (unita[i + 2] === 0 && unita[i + 3] === 1) testa = i + 4
    else continue

    if ((unita[testa]! & 0x1f) !== 7) continue // non e l'SPS
    if (testa + 3 >= unita.length) return null
    const esa = [unita[testa + 1]!, unita[testa + 2]!, unita[testa + 3]!]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return `avc1.${esa}`
  }
  return null
}

/**
 * Il secondo ingresso di ffmpeg: PCM continuo, costi quel che costi.
 *
 * Registrare anche l'audio del telefono (§3.7) vuol dire dare a ffmpeg un
 * secondo ingresso. La cosa da capire prima di tutte le altre e cosa succede se
 * quel secondo ingresso **tace**: ffmpeg aspetta, e mentre aspetta non scrive
 * nemmeno il video. Cioe accendere l'audio potrebbe far perdere il girato --
 * che e esattamente il contrario di quello che si voleva.
 *
 * Per questo qui non si inoltra e basta. Si **pompa**: ogni cento millisecondi
 * esce un blocco della dimensione giusta, riempito con i campioni arrivati dal
 * telefono e, se non ne sono arrivati abbastanza, con silenzio digitale. Il
 * flusso verso ffmpeg non si interrompe mai, nemmeno se il telefono sparisce a
 * meta ripresa: si sente silenzio, e il video continua. E lo stesso principio
 * del Flusso audio verso snapserver, per la stessa ragione.
 *
 * Il canale e una socket TCP su loopback e non una `pipe:`: su Windows i
 * descrittori oltre stdin/stdout/stderr non arrivano al processo figlio in modo
 * affidabile, e ffmpeg non saprebbe da dove leggere. `-i tcp://127.0.0.1:porta`
 * lo fa collegare a noi come un client qualsiasi.
 */
import net from 'node:net'

/** Il formato che l'app del telefono emette su `/audio`. */
export const FREQUENZA_AUDIO = 44100
export const CANALI_AUDIO = 1
const BYTE_PER_CAMPIONE = 2

/** Ogni quanto esce un blocco verso ffmpeg. */
const BLOCCO_MS = 100
/**
 * Quanto si aspetta un campione che non arriva prima di mettere silenzio.
 *
 * La rete consegna a raffiche: una coda vuota per qualche decina di
 * millisecondi e normale, e riempirla di silenzio produrrebbe un clic a ogni
 * raffica. Oltre un quarto di secondo, invece, non e piu jitter: e il telefono
 * che ha smesso.
 */
const PAZIENZA_MS = 250
/**
 * Quanto si puo restare indietro rispetto all'orologio prima di arrendersi.
 *
 * Se il telefono consegna stabilmente meno di 44100 campioni al secondo --
 * un orologio suo che va piano -- aspettarlo per sempre vorrebbe dire un audio
 * sempre piu in ritardo sul video. Oltre un secondo si mette silenzio e si
 * torna in pari: meglio un buco corto che una desincronizzazione crescente.
 */
const DEBITO_MASSIMO_MS = 1000
/**
 * Quanto audio del telefono si tiene da parte prima di buttarne via.
 *
 * Se la rete consegna a raffiche, la coda si allunga e ogni campione tenuto e
 * un campione che uscira in ritardo rispetto al video. Oltre mezzo secondo non
 * si recupera piu la sincronia: meglio buttare il piu vecchio e restare
 * agganciati all'adesso.
 */
const CODA_MASSIMA_MS = 500

const byteAlSecondo = FREQUENZA_AUDIO * CANALI_AUDIO * BYTE_PER_CAMPIONE

export class PompaAudio {
  private readonly server = net.createServer()
  private presa: net.Socket | null = null
  private coda: Buffer[] = []
  private byteInCoda = 0
  private battito: NodeJS.Timeout | null = null
  private avviata = false
  private chiusa = false
  /** Byte gia consegnati a ffmpeg: e l'orologio di questo flusso. */
  private byteScritti = 0
  private inizioMs = 0
  private silenzioMs = 0
  private ultimoCampioneIl = 0

  /** Apre la socket e restituisce la porta da dare a ffmpeg. */
  async apri(): Promise<number> {
    this.server.on('connection', (s) => {
      // ffmpeg apre un solo ingresso: una connessione sola, e le altre non
      // esistono. Se ne arrivasse una seconda sarebbe un errore nostro.
      if (this.presa) {
        s.destroy()
        return
      }
      this.presa = s
      s.on('error', () => {
        /* ffmpeg se n'e andato: se ne accorge il ciclo, non serve un allarme */
      })
      // Un ffmpeg che esce -- fine segmento, telefono caduto -- lascia il posto
      // a quello che verra dopo: la socket si libera, la porta resta la stessa.
      s.on('close', () => {
        if (this.presa === s) {
          this.presa = null
          this.sospendi()
        }
      })
    })
    await new Promise<void>((ok, ko) => {
      this.server.once('error', ko)
      this.server.listen(0, '127.0.0.1', ok)
    })
    return (this.server.address() as net.AddressInfo).port
  }

  /**
   * Fa partire l'orologio.
   *
   * Si chiama al **primo byte di video**, non all'avvio di ffmpeg: i due
   * ingressi vengono normalizzati da ffmpeg ciascuno a partire dal proprio
   * primo pacchetto, quindi farli cominciare insieme e l'unico modo semplice di
   * non ritrovarsi l'audio avanti di un secondo -- il tempo che passa prima che
   * arrivi il primo fotogramma chiave.
   */
  avvia(): void {
    if (this.avviata || this.chiusa) return
    this.avviata = true
    // L'orologio riparte da adesso a ogni file: dopo una caduta il nuovo
    // ffmpeg ricomincia da zero, e l'audio deve ricominciare con lui.
    this.inizioMs = Date.now()
    this.byteScritti = 0
    this.battito = setInterval(() => this.giro(), BLOCCO_MS)
    this.battito.unref?.()
  }

  /**
   * Chiude il secondo ingresso di ffmpeg.
   *
   * Va fatto **prima** di aspettare che ffmpeg esca. ffmpeg finisce quando
   * finiscono *tutti* i suoi ingressi: chiudere solo lo stdin del video lo
   * lascia in attesa su questa socket, e dopo cinque secondi lo si ammazza --
   * senza `moov`, cioe con un file che non si apre. E il modo piu diretto di
   * perdere la ripresa che si stava salvando.
   */
  staccaFfmpeg(): void {
    this.presa?.end()
    this.presa = null
    this.sospendi()
  }

  /** ffmpeg se n'e andato: si smette di pompare finche non torna. */
  sospendi(): void {
    if (this.battito) clearInterval(this.battito)
    this.battito = null
    this.avviata = false
    // La coda accumulata durante la pausa e roba vecchia: ripartirebbe con
    // mezzo secondo di ritardo gia addosso.
    this.coda = []
    this.byteInCoda = 0
  }

  /** Campioni arrivati dal telefono, gia senza intestazione. */
  campioni(dati: Uint8Array): void {
    if (this.chiusa) return
    this.ultimoCampioneIl = Date.now()
    this.coda.push(Buffer.from(dati))
    this.byteInCoda += dati.length
    const massimo = (byteAlSecondo * CODA_MASSIMA_MS) / 1000
    while (this.byteInCoda > massimo && this.coda.length > 0) {
      this.byteInCoda -= this.coda.shift()!.length
    }
  }

  async chiudi(): Promise<void> {
    this.chiusa = true
    if (this.battito) clearInterval(this.battito)
    this.battito = null
    this.presa?.end()
    this.presa = null
    this.coda = []
    this.byteInCoda = 0
    await new Promise<void>((ok) => this.server.close(() => ok()))
  }

  /** Quanti secondi di silenzio si sono dovuti inventare. Per il Diario. */
  get silenzioInventatoMs(): number {
    return this.silenzioMs
  }

  // ------------------------------------------------------------- interni

  private giro(): void {
    if (this.chiusa || !this.presa || this.presa.destroyed) return

    // Quanti byte dovrebbero essere usciti da quando si e partiti. Il ritmo lo
    // detta l'orologio, non il timer: su Windows `setInterval(100)` dorme
    // ~109 ms, e in dieci minuti sarebbero secondi di scarto.
    const attesi = Math.floor(((Date.now() - this.inizioMs) / 1000) * byteAlSecondo)
    let mancanti = attesi - this.byteScritti
    // Sempre su confine di campione, o i 16 bit si spezzano a meta e da li in
    // poi il rumore e garantito.
    mancanti -= mancanti % BYTE_PER_CAMPIONE
    if (mancanti <= 0) return

    const pezzi: Buffer[] = []
    let presi = 0
    while (presi < mancanti && this.coda.length > 0) {
      const primo = this.coda[0]!
      const serve = mancanti - presi
      if (primo.length <= serve) {
        pezzi.push(primo)
        presi += primo.length
        this.coda.shift()
        this.byteInCoda -= primo.length
      } else {
        pezzi.push(primo.subarray(0, serve))
        this.coda[0] = primo.subarray(serve)
        this.byteInCoda -= serve
        presi = mancanti
      }
    }
    if (presi < mancanti) {
      // Qui si decide se questo e jitter o un telefono che ha smesso. Nel
      // dubbio si aspetta: il silenzio messo per sbaglio in mezzo a una
      // raffica e un clic udibile, mentre mezzo tick di ritardo non lo sente
      // nessuno e si recupera al giro dopo.
      const quiete = Date.now() - this.ultimoCampioneIl
      const debito = ((mancanti - presi) / byteAlSecondo) * 1000
      if (quiete < PAZIENZA_MS && debito < DEBITO_MASSIMO_MS) {
        if (presi === 0) return
        mancanti = presi
      } else {
        const silenzio = mancanti - presi
        pezzi.push(Buffer.alloc(silenzio))
        this.silenzioMs += (silenzio / byteAlSecondo) * 1000
      }
    }

    this.byteScritti += mancanti
    // Contropressione ignorata come nello stdin del video: la destinazione e un
    // processo locale, e accumulare qualche decina di kilobyte in memoria e
    // sempre meglio che bucare la traccia.
    this.presa.write(Buffer.concat(pezzi))
  }
}

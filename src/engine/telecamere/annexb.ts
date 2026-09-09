/**
 * Spezza un flusso H.264 Annex-B in unita di accesso, cioe in fotogrammi.
 *
 * Serve perche i byte che arrivano dal telefono non hanno confini: sono un
 * flusso TCP, e un pacchetto puo tagliare una NAL a meta. Il decoder WebCodecs
 * vuole invece un `EncodedVideoChunk` per fotogramma, con il tipo giusto --
 * chiave o differenziale -- e sbagliare il tipo significa un decoder che non
 * parte mai o che sputa artefatti.
 *
 * Perche si puo fare cosi semplice: il Pixel 10 **non emette B-frame**
 * (`has_b_frames=0`) e ogni fotogramma e una sola slice. Su undici secondi di
 * `/video/h264` a 720x480 si contano 11 fotogrammi I e 209 P, in sequenza
 * `I P P P ...`. Quindi una NAL di slice (tipo 1 o 5) **chiude** l'unita di
 * accesso, e non serve leggere `first_mb_in_slice` per sapere dove comincia la
 * successiva.
 *
 * Ogni IDR e preceduto da SPS e PPS: l'unita chiave che ne esce e
 * autonomamente decodificabile, ed e per questo che tenerne una in cache fa
 * partire subito una seconda interfaccia invece di lasciarla nera fino a un
 * secondo.
 */

/** Tipi di NAL che ci interessano. Il resto passa e basta. */
const NAL_SLICE = 1
const NAL_IDR = 5

export class SpezzatoreAnnexB {
  /** Byte non ancora attribuiti a una NAL completa. */
  private resto = Buffer.alloc(0)
  /** Le NAL dell'unita in costruzione, codici di avvio inclusi. */
  private unita: Buffer[] = []
  private conChiave = false

  constructor(private readonly emetti: (unita: Uint8Array, chiave: boolean) => void) {}

  spingi(dati: Uint8Array): void {
    this.resto = this.resto.length === 0 ? Buffer.from(dati) : Buffer.concat([this.resto, dati])

    let inizio = trovaCodice(this.resto, 0)
    if (inizio < 0) {
      // Nessun codice di avvio ancora: si tiene tutto, ma non all'infinito --
      // un flusso che non e Annex-B non deve far crescere la memoria per ore.
      if (this.resto.length > 4 << 20) this.resto = this.resto.subarray(this.resto.length - 4)
      return
    }
    // Byte prima del primo codice di avvio: spazzatura di allineamento.
    if (inizio > 0) this.resto = this.resto.subarray(inizio)

    for (;;) {
      // Si cerca da 3, non da 1: un codice lungo `00 00 00 01` **contiene** un
      // codice corto `00 00 01` a partire dal suo secondo byte, e cercare da 1
      // lo troverebbe subito, tagliando ogni NAL dopo un byte solo. E un errore
      // che non da nessun sintomo qui e produce artefatti nel decoder.
      const dopo = trovaCodice(this.resto, 3)
      if (dopo < 0) break
      this.aggiungi(this.resto.subarray(0, dopo))
      this.resto = this.resto.subarray(dopo)
    }
  }

  /** Fine del flusso: cio che resta non e un fotogramma completo, si butta. */
  chiudi(): void {
    this.resto = Buffer.alloc(0)
    this.unita = []
    this.conChiave = false
  }

  private aggiungi(nal: Buffer): void {
    const lunghezzaCodice = nal[2] === 1 ? 3 : 4
    const testa = nal[lunghezzaCodice]
    if (testa === undefined) return
    const tipo = testa & 0x1f

    this.unita.push(nal)
    if (tipo === NAL_IDR) this.conChiave = true

    if (tipo === NAL_SLICE || tipo === NAL_IDR) {
      const fuori = this.unita.length === 1 ? this.unita[0]! : Buffer.concat(this.unita)
      const chiave = this.conChiave
      this.unita = []
      this.conChiave = false
      this.emetti(fuori, chiave)
    }
  }
}

/**
 * Il prossimo codice di avvio a partire da `da`, oppure -1.
 *
 * Accetta sia `00 00 01` che `00 00 00 01` e restituisce l'inizio del codice,
 * non della NAL: le unita che escono di qui devono contenere i propri codici,
 * perche e cosi che il decoder li vuole.
 */
function trovaCodice(b: Buffer, da: number): number {
  for (let i = da; i + 2 < b.length; i++) {
    if (b[i] !== 0 || b[i + 1] !== 0) continue
    if (b[i + 2] === 1) return i
    if (b[i + 2] === 0 && b[i + 3] === 1) return i
  }
  return -1
}

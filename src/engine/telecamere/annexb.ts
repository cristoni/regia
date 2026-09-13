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
const NAL_SPS = 7

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

  /**
   * I byte gia ricevuti ma non ancora emessi: le NAL complete dell'unita in
   * costruzione, piu la coda che non e ancora una NAL intera.
   *
   * Serve al taglio-segmento della registrazione (ADR 0012): quando un cambio
   * di geometria sostituisce il muxer a meta pacchetto, questi byte si
   * ridanno in pasto al nuovo, cosi il fotogramma a cavallo del taglio non si
   * perde. Sono Annex-B validi (le NAL portano i propri codici di avvio):
   * ripassarli da `spingi` ricostruisce lo stato del parser esattamente.
   */
  residuo(): Buffer {
    return Buffer.concat([...this.unita, this.resto])
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

/**
 * La geometria (`"1280x720"`) dichiarata dall'SPS di un'unita di accesso, o
 * `null` se l'unita non ha un SPS leggibile.
 *
 * Serve alla rete di sicurezza della registrazione (ADR 0012): con `-c:v copy`
 * il contenitore dichiara una sola dimensione, e un cambio di geometria a meta
 * blocca i lettori rigidi -- il muxer confronta la geometria di ogni fotogramma
 * chiave con quella del segmento in corso. Il confronto e sulla geometria, non
 * sui byte dell'SPS: un ri-invio identico o un cambio di solo PPS non contano.
 *
 * Si legge solo quel che serve ad arrivare a `pic_width_in_mbs` e al cropping
 * (spec H.264 §7.3.2.1.1), su una copia senza i byte di prevenzione
 * dell'emulazione (`00 00 03` -> `00 00`). Qualunque inciampo restituisce
 * `null`: un SPS che non si riesce a leggere non deve far cadere la ripresa.
 */
export function geometriaDi(unita: Uint8Array): string | null {
  const b = Buffer.from(unita.buffer, unita.byteOffset, unita.byteLength)
  let inizio = trovaCodice(b, 0)
  while (inizio >= 0) {
    const lunghezzaCodice = b[inizio + 2] === 1 ? 3 : 4
    const testa = b[inizio + lunghezzaCodice]
    const fine = trovaCodice(b, inizio + 3)
    if (testa !== undefined && (testa & 0x1f) === NAL_SPS) {
      const nal = b.subarray(inizio + lunghezzaCodice, fine < 0 ? b.length : fine)
      try {
        return leggiGeometriaSps(nal)
      } catch {
        return null
      }
    }
    inizio = fine
  }
  return null
}

/** I byte RBSP di una NAL: via l'intestazione e i `00 00 03` -> `00 00`. */
function rbsp(nal: Buffer): Buffer {
  const out = Buffer.alloc(nal.length - 1)
  let n = 0
  for (let i = 1; i < nal.length; i++) {
    if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
      out[n++] = 0
      out[n++] = 0
      i += 2
      continue
    }
    out[n++] = nal[i]!
  }
  return out.subarray(0, n)
}

class LettoreBit {
  private pos = 0
  constructor(private readonly b: Buffer) {}
  bit(): number {
    const byte = this.b[this.pos >> 3]
    if (byte === undefined) throw new Error('SPS troncato')
    const v = (byte >> (7 - (this.pos & 7))) & 1
    this.pos++
    return v
  }
  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit()
    return v
  }
  /** Exp-Golomb senza segno: `zeri` bit a 0, un 1, `zeri` bit di valore. */
  ue(): number {
    let zeri = 0
    while (this.bit() === 0) if (++zeri > 31) throw new Error('non e Exp-Golomb')
    return (1 << zeri) - 1 + this.bits(zeri)
  }
  se(): number {
    const k = this.ue()
    return k % 2 === 0 ? -(k / 2) : (k + 1) / 2
  }
}

/** Profili che portano `chroma_format_idc` e compagnia (spec, §7.3.2.1.1). */
const PROFILI_ESTESI = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

function leggiGeometriaSps(nal: Buffer): string {
  const r = new LettoreBit(rbsp(nal))
  const profilo = r.bits(8)
  r.bits(8) // constraint flag e riserva
  r.bits(8) // level_idc
  r.ue() // seq_parameter_set_id

  let chroma = 1 // 4:2:0, il default dei profili senza il campo
  let planiSeparati = 0
  if (PROFILI_ESTESI.has(profilo)) {
    chroma = r.ue()
    if (chroma === 3) planiSeparati = r.bit()
    r.ue() // bit_depth_luma_minus8
    r.ue() // bit_depth_chroma_minus8
    r.bit() // qpprime_y_zero_transform_bypass_flag
    if (r.bit() === 1) {
      // seq_scaling_matrix: liste da saltare per intero, contando come la spec
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (r.bit() === 0) continue
        const dimensione = i < 6 ? 16 : 64
        let ultimo = 8
        let prossimo = 8
        for (let j = 0; j < dimensione; j++) {
          if (prossimo !== 0) prossimo = (ultimo + r.se() + 256) % 256
          ultimo = prossimo === 0 ? ultimo : prossimo
        }
      }
    }
  }

  r.ue() // log2_max_frame_num_minus4
  const tipoPoc = r.ue()
  if (tipoPoc === 0) {
    r.ue() // log2_max_pic_order_cnt_lsb_minus4
  } else if (tipoPoc === 1) {
    r.bit() // delta_pic_order_always_zero_flag
    r.se() // offset_for_non_ref_pic
    r.se() // offset_for_top_to_bottom_field
    const cicli = r.ue()
    for (let i = 0; i < cicli; i++) r.se()
  }
  r.ue() // max_num_ref_frames
  r.bit() // gaps_in_frame_num_value_allowed_flag

  const larghezzaMb = r.ue() + 1
  const altezzaMappa = r.ue() + 1
  const soloFrame = r.bit()
  if (soloFrame === 0) r.bit() // mb_adaptive_frame_field_flag
  r.bit() // direct_8x8_inference_flag

  let larghezza = larghezzaMb * 16
  let altezza = (2 - soloFrame) * altezzaMappa * 16
  if (r.bit() === 1) {
    // frame_cropping: le unita di ritaglio dipendono dal sottocampionamento
    const sinistra = r.ue()
    const destra = r.ue()
    const sopra = r.ue()
    const sotto = r.ue()
    const tipoChroma = planiSeparati === 1 ? 0 : chroma
    const unitaX = tipoChroma === 0 || tipoChroma === 3 ? 1 : 2
    const unitaY = (tipoChroma === 1 ? 2 : 1) * (2 - soloFrame)
    larghezza -= unitaX * (sinistra + destra)
    altezza -= unitaY * (sopra + sotto)
  }
  return `${larghezza}x${altezza}`
}

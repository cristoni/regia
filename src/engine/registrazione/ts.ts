/**
 * Un muxer MPEG-TS minimo, per dare a ogni fotogramma un timestamp che nasce
 * QUI, non dall'orologio di ffmpeg.
 *
 * ⚠️ **Perche esiste.** Prima la registrazione dava a ffmpeg lo stream H.264
 * grezzo con `-use_wallclock_as_timestamps 1`: ffmpeg timbrava ogni fotogramma
 * con l'ora **di lettura** dallo stdin, e con l'ingresso audio accanto il suo
 * muxer, che ordina per DTS, drenava sempre l'audio (DTS da ~0) e affamava il
 * lettore video (DTS all'epoch, ~1,7 miliardi di secondi piu in la). Il video
 * usciva a ~4 fps e l'arretrato si scaricava tutto alla chiusura: la
 * registrazione diventava una diapositiva seguita da un avanti-veloce. Nessuna
 * impostazione di interleave colma un divario da un epoch, e portare l'audio
 * all'epoch rompe l'audio. Misurato il 2026-09-11; vedi `docs/fatti-verificati.md`.
 *
 * La cura: **Regia assegna i PTS**. Ogni unita di accesso esce come un PES con
 * un PTS preso dall'orologio al momento dell'emissione, riportato a zero sul
 * primo fotogramma. I timestamp sono monotoni e vicini allo zero, nello stesso
 * intervallo del conteggio-campioni dell'audio: il muxer di ffmpeg li interleava
 * come si deve, la segmentazione funziona, e il video resta `-c:v copy`. Sotto
 * un WiFi a raffiche i PTS riflettono l'arrivo reale (una pausa e una pausa),
 * non piu una linea temporale falsificata dalla contropressione del muxer.
 *
 * E' un muxer volutamente ridotto: un solo programma, una sola traccia video
 * H.264. L'audio non passa di qui -- resta il secondo ingresso TCP di ffmpeg.
 *
 * ⚠️ **Assunzione: una slice per fotogramma.** Un PES esce per ogni unita che
 * lo `SpezzatoreAnnexB` emette, e lo spezzatore emette su ogni NAL di slice.
 * Sul telefono e' misurato che c'e' una sola slice per fotogramma (annexb.ts),
 * quindi un'unita = un fotogramma = un PES con un PTS. Una sorgente multi-slice
 * spezzerebbe un fotogramma in piu' PES con PTS diversi -- ma la stessa
 * assunzione la fa gia' il conteggio degli fps del gestore, quindi il muxer non
 * e' piu' fragile del resto della catena video.
 */
import { SpezzatoreAnnexB, geometriaDi } from '../telecamere/annexb.js'

const SYNC = 0x47
const PID_PAT = 0x0000
const PID_PMT = 0x1000
const PID_VIDEO = 0x0100
/** H.264 in un PMT. */
const TIPO_STREAM_H264 = 0x1b
/** `0xE0` = video elementare, il primo. */
const STREAM_ID_VIDEO = 0xe0

/** CRC-32 MPEG-2 (poly 0x04C11DB7, init tutti 1, MSB-first), come nelle sezioni PSI. */
function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of buf) {
    crc ^= b << 24
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1
      crc >>>= 0
    }
  }
  return crc >>> 0
}

/** Una sezione PSI (PAT/PMT) col suo pointer_field e il CRC in coda. */
function sezione(corpo: Uint8Array): Uint8Array {
  const crc = crc32(corpo)
  const out = new Uint8Array(1 + corpo.length + 4)
  out[0] = 0x00 // pointer_field
  out.set(corpo, 1)
  const o = 1 + corpo.length
  out[o] = (crc >>> 24) & 0xff
  out[o + 1] = (crc >>> 16) & 0xff
  out[o + 2] = (crc >>> 8) & 0xff
  out[o + 3] = crc & 0xff
  return out
}

function costruisciPat(): Uint8Array {
  // table_id, flags+len, tsid(2), ver/cur, sec#, last#, program(2), pmtPid(2)
  const corpo = new Uint8Array([
    0x00,
    0xb0, 0x0d, // section_syntax=1 + lunghezza 13
    0x00, 0x01, // transport_stream_id
    0xc1, // reserved'11' ver0 current_next1
    0x00, 0x00, // section_number, last_section_number
    0x00, 0x01, // program_number 1
    0xe0 | ((PID_PMT >> 8) & 0x1f), PID_PMT & 0xff,
  ])
  return incapsulaSezione(sezione(corpo), PID_PAT)
}

function costruisciPmt(): Uint8Array {
  const corpo = new Uint8Array([
    0x02,
    0xb0, 0x12, // lunghezza 18
    0x00, 0x01, // program_number
    0xc1, 0x00, 0x00, // ver/cur, sec#, last#
    0xe0 | ((PID_VIDEO >> 8) & 0x1f), PID_VIDEO & 0xff, // PCR_PID = video
    0xf0, 0x00, // program_info_length 0
    TIPO_STREAM_H264,
    0xe0 | ((PID_VIDEO >> 8) & 0x1f), PID_VIDEO & 0xff,
    0xf0, 0x00, // ES_info_length 0
  ])
  return incapsulaSezione(sezione(corpo), PID_PMT)
}

/** Una sezione PSI sta in un solo pacchetto TS (PAT/PMT sono piccole). */
function incapsulaSezione(sez: Uint8Array, pid: number): Uint8Array {
  const pkt = new Uint8Array(188).fill(0xff)
  pkt[0] = SYNC
  pkt[1] = 0x40 | ((pid >> 8) & 0x1f) // payload_unit_start_indicator
  pkt[2] = pid & 0xff
  pkt[3] = 0x10 // solo payload, continuity 0 (le PSI si possono rimandare con cc 0)
  pkt.set(sez, 4)
  return pkt
}

/** I 5 byte di un PTS a 33 bit, col prefisso e i marker bit. */
function scriviPts(prefisso: number, pts: number, out: Uint8Array, o: number): void {
  out[o] = (prefisso << 4) | ((Math.floor(pts / 2 ** 30) & 0x07) << 1) | 1
  out[o + 1] = Math.floor(pts / 2 ** 22) & 0xff
  out[o + 2] = ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1
  out[o + 3] = Math.floor(pts / 2 ** 7) & 0xff
  out[o + 4] = ((pts & 0x7f) << 1) | 1
}

export interface OpzioniMuxTs {
  /** Riceve pacchetti TS gia pronti (multipli di 188 byte). */
  readonly scrivi: (ts: Uint8Array) => void
  /** L'orologio, iniettabile per il test. Default: `performance.now()`. */
  readonly adesso?: () => number
  /**
   * La rete di sicurezza del taglio-segmento (ADR 0012).
   *
   * Un fotogramma chiave porta una geometria diversa da quella del segmento in
   * corso: con `-c:v copy` il contenitore ne dichiara una sola, e i lettori
   * rigidi si bloccherebbero sul cambio. Chi riceve la chiamata chiude il
   * segmento e ne apre uno nuovo (il ciclo caduta->ripresa del registratore),
   * e restituisce il muxer del segmento nuovo: questo muxer gli inoltrera il
   * fotogramma chiave incriminato e tutto cio che spezza da qui in poi, cosi
   * il nuovo segmento parte esattamente dall'unita che ha cambiato geometria.
   * Restituire `null` significa "non taglio": si prosegue sul segmento in
   * corso, aggiornando la geometria di riferimento.
   */
  readonly suCambioGeometria?: (da: string, a: string) => MuxTs | null
}

/**
 * Trasforma il flusso di byte H.264 di una Telecamera in MPEG-TS con PTS nostri.
 *
 * Si spinge dentro il byte grezzo (`spingi`), e a ogni unita di accesso completa
 * escono i pacchetti TS dal callback `scrivi` -- ma non prima del primo
 * fotogramma chiave: fino a quello non esce nulla (vedi `emettiUnita`). Il primo
 * fotogramma emesso fissa lo zero della linea temporale, quindi un ffmpeg nuovo
 * (dopo una ripresa) vuole un muxer nuovo.
 */
export class MuxTs {
  private readonly spezzatore: SpezzatoreAnnexB
  private readonly scrivi: (ts: Uint8Array) => void
  private readonly adesso: () => number
  private readonly suCambioGeometria: ((da: string, a: string) => MuxTs | null) | null
  private t0: number | null = null
  private ultimoPts = -1
  private ccVideo = 0
  private chiaveVista = false
  /** La geometria del segmento in corso, letta dall'SPS del primo chiave. */
  private geometria: string | null = null
  /**
   * Il muxer del segmento aperto dopo un taglio di geometria. Da quel momento
   * questo muxer non scrive piu: fa solo da spezzatore per i byte che gli
   * arrivano ancora (il pacchetto in corso di `spingi`) e inoltra le unita.
   */
  private successore: MuxTs | null = null

  constructor(opzioni: OpzioniMuxTs) {
    this.scrivi = opzioni.scrivi
    this.adesso = opzioni.adesso ?? (() => performance.now())
    this.suCambioGeometria = opzioni.suCambioGeometria ?? null
    this.spezzatore = new SpezzatoreAnnexB((unita, chiave) => this.emettiUnita(unita, chiave))
  }

  spingi(byte: Uint8Array): void {
    this.spezzatore.spingi(byte)
  }

  /** Butta l'ultima unita incompleta: non e un fotogramma, non si registra. */
  chiudi(): void {
    this.spezzatore.chiudi()
  }

  /**
   * Un'unita di accesso gia spezzata, da un muxer che ha appena tagliato
   * (ADR 0012): entra nella linea temporale di QUESTO muxer come se l'avesse
   * spezzata lui. La prima e sempre il fotogramma chiave con la geometria
   * nuova, quindi fissa lo zero e la geometria del segmento.
   */
  accetta(unita: Uint8Array, chiave: boolean): void {
    this.emettiUnita(unita, chiave)
  }

  /** I byte non ancora emessi dallo spezzatore: per il passaggio di consegne. */
  residuo(): Uint8Array {
    return this.spezzatore.residuo()
  }

  private emettiUnita(unita: Uint8Array, chiave: boolean): void {
    // Dopo un taglio le unita vanno al segmento nuovo, non a questo: lo
    // spezzatore di qui resta l'unico ad avere in pancia i byte a cavallo.
    if (this.successore) {
      this.successore.accetta(unita, chiave)
      return
    }
    // Prima del primo fotogramma chiave non esce NIENTE. La registrazione
    // comincia quasi sempre a meta GOP (il gestore consegna i byte da dove si
    // trova lo stream), e quei P-frame senza riferimenti nessuno li decodifica.
    // Peggio: le dimensioni del video ffmpeg le legge dall'SPS, che viaggia col
    // fotogramma chiave (annexb.ts, misurato) -- se il primo chiave e oltre la
    // sua finestra di sondaggio, ffmpeg si arrende («Could not find codec
    // parameters»), non scrive l'intestazione e il file resta VUOTO, in
    // silenzio. Misurato l'11 settembre 2026, e capitava uguale col vecchio
    // ingresso H.264 grezzo. Trattenere fino al chiave elimina la classe di
    // guasto: il primo byte che ffmpeg vede e sempre SPS+PPS+IDR.
    if (!this.chiaveVista) {
      if (!chiave) return
      this.chiaveVista = true
    }

    // La rete di sicurezza (ADR 0012): l'SPS viaggia col fotogramma chiave
    // (annexb.ts, misurato), quindi e qui che una geometria nuova si vede. Il
    // confronto e sulla geometria, non sui byte: un SPS ri-inviato identico o
    // un cambio di solo PPS non tagliano niente. Se nessuno gestisce il taglio
    // (o il taglio fallisce), si aggiorna il riferimento e si continua: meglio
    // un file che i lettori rigidi bloccano che nessun file.
    if (chiave) {
      const g = geometriaDi(unita)
      if (g !== null) {
        if (this.geometria !== null && g !== this.geometria && this.suCambioGeometria) {
          const successore = this.suCambioGeometria(this.geometria, g)
          if (successore) {
            this.successore = successore
            successore.accetta(unita, chiave)
            return
          }
        }
        this.geometria = g
      }
    }

    const ora = this.adesso()
    this.t0 ??= ora
    // PTS a 90 kHz, dallo zero del primo fotogramma. Strettamente crescente:
    // due unita nello stesso millisecondo non devono dare lo stesso PTS.
    let pts = Math.round((ora - this.t0) * 90)
    if (pts <= this.ultimoPts) pts = this.ultimoPts + 1
    this.ultimoPts = pts

    // PAT e PMT prima di ogni keyframe -- e la prima unita che esce di qui E'
    // un keyframe, quindi ffmpeg le ha prima di qualunque video. Rimandarle poi
    // serve a un lettore che si aggancia a meta (o a ffmpeg che apre un
    // segmento nuovo): le ritrova subito.
    if (chiave) {
      this.scrivi(costruisciPat())
      this.scrivi(costruisciPmt())
    }

    // Intestazione PES: start code, stream_id, lunghezza 0 (illimitata, buona
    // per i fotogrammi grandi), flag, PTS.
    const pes = new Uint8Array(14 + unita.length)
    pes[0] = 0x00
    pes[1] = 0x00
    pes[2] = 0x01
    pes[3] = STREAM_ID_VIDEO
    pes[4] = 0x00 // PES_packet_length = 0 (illimitata)
    pes[5] = 0x00
    pes[6] = 0x80 // '10', nessun scrambling, ecc.
    pes[7] = 0x80 // PTS presente, DTS no
    pes[8] = 0x05 // PES_header_data_length: 5 byte di PTS
    scriviPts(0x2, pts, pes, 9) // prefisso '0010' = solo PTS
    pes.set(unita, 14)

    this.impacchetta(pes, pts, chiave)
  }

  /** Spezza un PES in pacchetti TS da 188 byte sul PID video. */
  private impacchetta(pes: Uint8Array, pts: number, chiave: boolean): void {
    let off = 0
    let primo = true
    const pacchetti: Uint8Array[] = []
    while (off < pes.length) {
      const pkt = new Uint8Array(188).fill(0xff)
      pkt[0] = SYNC
      pkt[1] = (primo ? 0x40 : 0x00) | ((PID_VIDEO >> 8) & 0x1f)
      pkt[2] = PID_VIDEO & 0xff

      // Il primo pacchetto porta un adaptation field con il PCR (e il flag di
      // accesso casuale sui keyframe); l'ultimo, se il payload non riempie i
      // 188 byte, ne porta uno di solo riempimento.
      const restante = pes.length - off
      const vuoleAf = primo || restante < 184
      let idx = 4
      if (vuoleAf) {
        const conPcr = primo
        const dimAf = conPcr ? 8 : 2 // len-byte incluso: flags(1)+PCR(6) o flags(1) e basta
        // Spazio per il payload dopo l'adaptation field.
        const spazioPayload = 188 - 4 - dimAf
        const payloadQui = Math.min(restante, spazioPayload)
        const stuffing = spazioPayload - payloadQui // riempimento se il payload non basta
        pkt[3] = 0x30 | (this.ccVideo & 0x0f) // adaptation + payload
        const afLen = dimAf - 1 + stuffing
        pkt[idx++] = afLen
        let flags = 0
        if (chiave && primo) flags |= 0x40 // random_access_indicator
        if (conPcr) flags |= 0x10 // PCR_flag
        pkt[idx++] = flags
        if (conPcr) {
          const base = pts // PCR base a 90 kHz = PTS; estensione 0
          pkt[idx++] = Math.floor(base / 2 ** 25) & 0xff
          pkt[idx++] = Math.floor(base / 2 ** 17) & 0xff
          pkt[idx++] = Math.floor(base / 2 ** 9) & 0xff
          pkt[idx++] = Math.floor(base / 2 ** 1) & 0xff
          pkt[idx++] = ((base & 0x1) << 7) | 0x7e // 6 reserved + ext high bit 0
          pkt[idx++] = 0x00
        }
        idx += stuffing // i byte di stuffing sono gia 0xff dal fill
        pkt.set(pes.subarray(off, off + payloadQui), idx)
        off += payloadQui
      } else {
        pkt[3] = 0x10 | (this.ccVideo & 0x0f) // solo payload
        const payloadQui = Math.min(restante, 184)
        pkt.set(pes.subarray(off, off + payloadQui), 4)
        off += payloadQui
      }
      this.ccVideo = (this.ccVideo + 1) & 0x0f
      primo = false
      pacchetti.push(pkt)
    }
    // Un'unica scrittura per unita di accesso: meno syscall verso lo stdin.
    const totale = new Uint8Array(pacchetti.length * 188)
    for (let i = 0; i < pacchetti.length; i++) totale.set(pacchetti[i]!, i * 188)
    this.scrivi(totale)
  }
}

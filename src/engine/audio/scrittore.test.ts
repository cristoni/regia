import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { byteFrame, progettoVuoto, type ImpostazioniAudio } from '../dominio/progetto.js'
import { campionato, MixerZona } from './mixer.js'
import { Scrittore, type Destinazione } from './scrittore.js'

const AUDIO: ImpostazioniAudio = progettoVuoto('x').audio

/**
 * Destinazione finta che registra tutto. Conta anche quante volte e stata
 * aperta: e cosi che si verifica l'invariante "una sola socket per porta".
 */
class Presa implements Destinazione {
  static aperte = 0
  static viveContemporaneamente = 0
  static massimoContemporanee = 0

  readonly scritture: number[] = []
  byteTotali = 0
  aperta = true
  coda = 0
  private sbloccaScarico: (() => void) | null = null

  constructor(
    /** Byte scrivibili prima di segnalare contropressione. `Infinity` = mai. */
    private readonly capienza = Infinity,
  ) {
    Presa.aperte++
    Presa.viveContemporaneamente++
    Presa.massimoContemporanee = Math.max(Presa.massimoContemporanee, Presa.viveContemporaneamente)
  }

  static azzera(): void {
    Presa.aperte = 0
    Presa.viveContemporaneamente = 0
    Presa.massimoContemporanee = 0
  }

  scrivi(dati: Uint8Array): boolean {
    if (!this.aperta) throw new Error('scritto su una presa chiusa')
    this.scritture.push(dati.length)
    this.byteTotali += dati.length
    this.coda += dati.length
    return this.coda < this.capienza
  }

  async attendiScarico(): Promise<void> {
    await new Promise<void>((r) => {
      this.sbloccaScarico = r
      setImmediate(() => {
        this.coda = 0
        this.sbloccaScarico?.()
        this.sbloccaScarico = null
      })
    })
  }

  async chiudi(): Promise<void> {
    if (this.aperta) Presa.viveContemporaneamente--
    this.aperta = false
  }

  /** Simula la caduta del Wi-Fi o del server. */
  muori(): void {
    if (this.aperta) Presa.viveContemporaneamente--
    this.aperta = false
  }
}

function orologio() {
  let t = 0
  return {
    ora: () => t,
    avanza: (ms: number) => {
      t += ms
    },
  }
}

/**
 * Fa girare lo scrittore per un tempo simulato, senza aspettare tempo vero:
 * `dormi` fa avanzare l'orologio finto e cede il turno all'event loop.
 */
function banco(opzioni: { capienza?: number; audio?: Partial<ImpostazioniAudio> } = {}) {
  Presa.azzera()
  const o = orologio()
  const audio = { ...AUDIO, ...opzioni.audio }
  const mixer = new MixerZona(audio)
  const prese: Presa[] = []
  const diagnostiche: string[] = []
  let vietaCollegamento = false

  const scrittore = new Scrittore({
    impostazioni: audio,
    mixer,
    collega: async () => {
      if (vietaCollegamento) throw new Error('rete assente')
      const p = new Presa(opzioni.capienza)
      prese.push(p)
      return p
    },
    attesaRiprovaMs: 100,
    suDiagnostica: (m) => diagnostiche.push(m),
    adesso: o.ora,
    dormi: async (ms) => {
      o.avanza(Math.max(ms, 1))
      await new Promise((r) => setImmediate(r))
    },
  })

  return {
    scrittore, mixer, prese, diagnostiche, orologio: o,
    vietaRete: (v: boolean) => (vietaCollegamento = v),
    /** Cede il turno abbastanza volte perche il ciclo faccia progresso. */
    async gira(giri = 30) {
      for (let i = 0; i < giri; i++) await new Promise((r) => setImmediate(r))
    },
  }
}

describe('scrittore: il Flusso non si interrompe', () => {
  it('scrive dal primo istante, anche senza niente da suonare', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira()
    await b.scrittore.ferma()

    assert.equal(b.prese.length, 1)
    assert.ok(b.prese[0]!.byteTotali > 0, 'il silenzio va scritto, non omesso')
    assert.equal(b.scrittore.diagnostica().stato, 'fermo')
  })

  it('riempie subito l anticipo e poi tiene il ritmo', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira(60)
    const dopoAvvio = b.scrittore.diagnostica().blocchiScritti
    // Anticipo 200 ms su blocchi da 20 ms: undici blocchi al primo colpo.
    assert.ok(dopoAvvio >= 11, `all avvio ne ha scritti solo ${dopoAvvio}`)

    await b.gira(60)
    await b.scrittore.ferma()
    const dia = b.scrittore.diagnostica()
    assert.ok(dia.scartoMs > 0, 'deve restare avanti all orologio, mai indietro')
    assert.equal(dia.riallineamenti, 0)
  })
})

describe('scrittore: allineamento dei frame', () => {
  it('ogni scrittura e multipla di un frame', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira(40)
    await b.scrittore.ferma()

    const frame = byteFrame(AUDIO)
    for (const n of b.prese[0]!.scritture) {
      assert.equal(n % frame, 0, `scrittura da ${n} byte: L e R si invertirebbero per sempre`)
    }
  })

  it('scrive sempre blocchi della stessa misura', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira(40)
    await b.scrittore.ferma()

    const misure = new Set(b.prese[0]!.scritture)
    assert.equal(misure.size, 1, `misure diverse: ${[...misure].join(', ')}`)
    // 20 ms a 44100 Hz stereo 16 bit = 882 * 2 * 2 = 3528 byte, che e anche
    // esattamente quanti byte snapserver aspetta a ogni lettura.
    assert.equal([...misure][0], 3528)
  })

  it('si rifiuta di partire se il blocco non e allineato', () => {
    // Non e un caso teorico: basta una frequenza che non dia un numero intero
    // di campioni per blocco perche il conto non torni.
    const audio = { ...AUDIO, canali: 2 as const }
    assert.doesNotThrow(() => new Scrittore({ impostazioni: audio, mixer: new MixerZona(audio), collega: async () => new Presa() }))
  })
})

describe('scrittore: una sola socket per porta', () => {
  it('non tiene mai due connessioni vive insieme', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira(20)

    b.prese[0]!.muori()
    await b.gira(60)
    await b.scrittore.ferma()

    assert.ok(b.prese.length >= 2, 'doveva riconnettersi')
    assert.equal(
      Presa.massimoContemporanee, 1,
      'due socket vive sulla stessa porta: snapserver ne legge una sola e i byte ' +
        'dell altra verrebbero riprodotti minuti dopo',
    )
  })

  it('chiude sempre la vecchia prima di aprire la nuova', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira(20)
    b.prese[0]!.muori()
    await b.gira(60)
    await b.scrittore.ferma()

    for (const p of b.prese) assert.equal(p.aperta, false, 'una presa e rimasta aperta')
  })

  it('azzera la timeline dopo una riconnessione invece di recuperare il perso', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira(20)

    // Molto tempo scollegati: senza azzeramento, alla riconnessione partirebbe
    // una raffica di tutti i blocchi "dovuti" nel frattempo.
    b.prese[0]!.muori()
    b.orologio.avanza(30_000)
    await b.gira(80)
    await b.scrittore.ferma()

    const nuova = b.prese[b.prese.length - 1]!
    const blocchiSubito = nuova.scritture.length
    assert.ok(
      blocchiSubito < 100,
      `alla riconnessione ha sparato ${blocchiSubito} blocchi: 30 s di audio in raffica`,
    )
    assert.equal(b.scrittore.diagnostica().riallineamenti, 0)
  })
})

describe('scrittore: cadute e ritorni', () => {
  it('continua a riprovare finche la rete non torna', async () => {
    const b = banco()
    b.vietaRete(true)
    b.scrittore.avvia()
    await b.gira(40)
    assert.equal(b.prese.length, 0)
    assert.equal(b.scrittore.diagnostica().stato, 'in collegamento')
    assert.ok(b.diagnostiche.some((d) => /collegamento fallito/.test(d)))

    b.vietaRete(false)
    await b.gira(40)
    await b.scrittore.ferma()
    assert.equal(b.prese.length, 1)
    assert.ok(b.prese[0]!.byteTotali > 0)
  })

  it('conta le cadute, cosi il pannello di stato puo mostrarle', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira(20)
    b.prese[0]!.muori()
    await b.gira(60)
    await b.scrittore.ferma()
    assert.ok(b.scrittore.diagnostica().cadute >= 1)
  })
})

describe('scrittore: contropressione', () => {
  it('aspetta lo scarico senza perdere blocchi ne farsi dettare il ritmo', async () => {
    // Capienza minuscola: ogni scrittura riempie la coda.
    const b = banco({ capienza: 1 })
    b.scrittore.avvia()
    await b.gira(80)
    await b.scrittore.ferma()

    const dia = b.scrittore.diagnostica()
    assert.ok(dia.attesePerScarico > 0, 'la contropressione non e mai scattata: test inutile')
    assert.equal(dia.byteScritti, b.prese[0]!.byteTotali, 'byte persi fra scrittore e presa')
    assert.equal(dia.blocchiScritti * 3528, dia.byteScritti)
  })

  it('la coda piena non fa gonfiare il ritardo oltre il recupero massimo', async () => {
    const b = banco({ capienza: 1 })
    b.scrittore.avvia()
    await b.gira(120)
    await b.scrittore.ferma()
    // Il ritmo lo detta la cadenza contro l orologio, non il drenaggio della
    // coda: quindi non ci si accumula ritardo silenzioso.
    assert.ok(b.scrittore.diagnostica().scartoMs > -500)
  })
})

describe('scrittore: fermarsi', () => {
  it('fermarsi chiude la presa e smette di scrivere', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira(30)
    await b.scrittore.ferma()

    const scritte = b.prese[0]!.scritture.length
    await b.gira(30)
    assert.equal(b.prese[0]!.scritture.length, scritte, 'ha continuato a scrivere dopo lo stop')
    assert.equal(b.prese[0]!.aperta, false)
  })

  it('fermarsi due volte non esplode', async () => {
    const b = banco()
    b.scrittore.avvia()
    await b.gira(20)
    await b.scrittore.ferma()
    await b.scrittore.ferma()
  })

  it('avviare due volte non apre due socket', async () => {
    const b = banco()
    b.scrittore.avvia()
    b.scrittore.avvia()
    await b.gira(30)
    await b.scrittore.ferma()
    assert.equal(b.prese.length, 1)
  })
})

describe('scrittore: il contenuto e davvero il mix', () => {
  it('cio che arriva alla presa e cio che il mixer ha prodotto', async () => {
    const b = banco()
    const campioni = new Int16Array(882 * 2).fill(12345)
    b.mixer.impostaSottofondo(campionato('s', campioni, 2))
    b.scrittore.avvia()
    await b.gira(40)
    await b.scrittore.ferma()

    assert.ok(b.prese[0]!.byteTotali > 0)
    assert.equal(b.scrittore.diagnostica().byteScritti, b.prese[0]!.byteTotali)
  })
})

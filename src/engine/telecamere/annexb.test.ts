/**
 * Lo spezzatore Annex-B, provato sui casi che succedono davvero su una rete.
 *
 * Il caso interessante non e il flusso pulito: e il pacchetto TCP che taglia
 * una NAL a meta, che succede continuamente. Se lo spezzatore sbagliasse li,
 * il decoder riceverebbe fotogrammi troncati e l'anteprima si riempirebbe di
 * artefatti verdi -- il tipo di guasto che si scopre la sera dell'evento.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SpezzatoreAnnexB, geometriaDi } from './annexb.js'

/** Una NAL finta: codice di avvio, intestazione col tipo, e del riempimento. */
function nal(tipo: number, riempimento = 8, corto = false): Buffer {
  const codice = corto ? Buffer.from([0, 0, 1]) : Buffer.from([0, 0, 0, 1])
  const testa = Buffer.from([0x60 | tipo])
  return Buffer.concat([codice, testa, Buffer.alloc(riempimento, tipo)])
}

const SPS = 7
const PPS = 8
const IDR = 5
const SLICE = 1

function raccogli(): {
  spezzatore: SpezzatoreAnnexB
  unita: { byte: number; chiave: boolean }[]
} {
  const unita: { byte: number; chiave: boolean }[] = []
  const spezzatore = new SpezzatoreAnnexB((u, chiave) => unita.push({ byte: u.length, chiave }))
  return { spezzatore, unita }
}

describe('spezzatore Annex-B', () => {
  it('mette SPS, PPS e IDR in una sola unita, marcata come chiave', () => {
    const { spezzatore, unita } = raccogli()
    spezzatore.spingi(Buffer.concat([nal(SPS), nal(PPS), nal(IDR)]))
    // L'unita non esce finche non arriva qualcosa dopo la slice: la fine di una
    // NAL si riconosce solo dall'inizio della successiva.
    spezzatore.spingi(nal(SLICE))

    assert.equal(unita.length, 1)
    assert.equal(unita[0]!.chiave, true)
    assert.equal(unita[0]!.byte, nal(SPS).length + nal(PPS).length + nal(IDR).length)
  })

  it('marca come differenziale un fotogramma senza IDR', () => {
    const { spezzatore, unita } = raccogli()
    spezzatore.spingi(Buffer.concat([nal(SLICE), nal(SLICE), nal(SLICE)]))
    assert.equal(unita.length, 2)
    assert.deepEqual(
      unita.map((u) => u.chiave),
      [false, false],
    )
  })

  it('regge una NAL tagliata a meta fra due pacchetti', () => {
    const { spezzatore, unita } = raccogli()
    const flusso = Buffer.concat([nal(SPS), nal(PPS), nal(IDR, 40), nal(SLICE, 40), nal(SLICE)])

    // Un byte per volta: il taglio piu cattivo possibile, compreso quello in
    // mezzo a un codice di avvio.
    for (const b of flusso) spezzatore.spingi(Buffer.from([b]))

    assert.equal(unita.length, 2)
    assert.equal(unita[0]!.chiave, true)
    assert.equal(unita[1]!.chiave, false)
  })

  it('accetta i codici di avvio corti e lunghi mescolati', () => {
    const { spezzatore, unita } = raccogli()
    spezzatore.spingi(
      Buffer.concat([nal(SPS, 8, true), nal(PPS), nal(IDR, 8, true), nal(SLICE), nal(SLICE)]),
    )
    assert.equal(unita.length, 2)
    assert.equal(unita[0]!.chiave, true)
  })

  it('butta via i byte prima del primo codice di avvio', () => {
    const { spezzatore, unita } = raccogli()
    spezzatore.spingi(Buffer.from('spazzatura di allineamento', 'utf8'))
    spezzatore.spingi(Buffer.concat([nal(IDR), nal(SLICE)]))
    assert.equal(unita.length, 1)
    assert.equal(unita[0]!.byte, nal(IDR).length)
  })

  it('non fa crescere la memoria se il flusso non e Annex-B', () => {
    const { spezzatore, unita } = raccogli()
    for (let i = 0; i < 200; i++) spezzatore.spingi(Buffer.alloc(64 * 1024, 0x41))
    assert.equal(unita.length, 0)
  })

  /**
   * Il passaggio di consegne del taglio-segmento (ADR 0012): il residuo di uno
   * spezzatore, ridato in pasto a uno nuovo, deve ricostruirne lo stato
   * esattamente -- le stesse unita devono uscire, ovunque cada il taglio.
   */
  it('residuo + spezzatore nuovo = le stesse unita, ovunque cada il taglio', () => {
    const flusso = Buffer.concat([nal(SPS), nal(PPS), nal(IDR, 40), nal(SLICE, 40), nal(SLICE), nal(SLICE)])
    const riferimento = raccogli()
    riferimento.spezzatore.spingi(flusso)

    for (let taglio = 1; taglio < flusso.length; taglio++) {
      const primo = raccogli()
      primo.spezzatore.spingi(flusso.subarray(0, taglio))
      const secondo = raccogli()
      secondo.spezzatore.spingi(primo.spezzatore.residuo())
      secondo.spezzatore.spingi(flusso.subarray(taglio))
      assert.deepEqual(
        [...primo.unita, ...secondo.unita],
        riferimento.unita,
        `il taglio a ${taglio} cambia le unita emesse`,
      )
    }
  })
})

/**
 * SPS veri, generati con libx264 (`ffmpeg -f lavfi -i color=black:size=WxH
 * -c:v libx264 -profile:v ...`) ed estratti dal flusso: gli hex qui sotto sono
 * la NAL SPS cosi com'e, coi byte di prevenzione dell'emulazione dentro
 * (`00 00 03` compare in tutti quelli di libx264). Coprono il profilo esteso e
 * il baseline, e le geometrie che vogliono il cropping (1080 e 300 non sono
 * multipli di 16). Quelli **verticali** vengono da libopenh264 (l'ffmpeg in
 * `vendor/` non ha libx264): sono il verso che manda un telefono in piedi con
 * la rotazione cotta nel flusso (ADR 0013), e l'orientamento si decide su
 * questi numeri.
 */
describe('geometriaDi: la geometria dichiarata dall SPS (ADR 0012)', () => {
  const casi: [string, string, string][] = [
    ['1280x720', 'high', '6764001facd9405005bb0110000003001000000303c0f1831960'],
    ['800x608', 'high', '6764001facd940c8136c0440000003004000000f03c60c6580'],
    ['1920x1080', 'high (crop verticale)', '67640028acd940780227e5c044000003000400000300f03c60c658'],
    ['300x180', 'high (crop orizzontale)', '6764000dacd941319ee7c044000003000400000300f03c50a658'],
    ['640x360', 'baseline', '6742c01ed900a02ff970110000030001000003003c0f162e48'],
    ['720x1280', 'baseline verticale (libopenh264)', '6742c01f8c680b40a1b0101e1108d4'],
    ['360x640', 'baseline verticale (libopenh264)', '6742c01e8c6817051e5f0101e1108d40'],
    ['1080x1920', 'baseline verticale con crop (libopenh264)', '6742c0288c6804403c797c0407844235'],
  ]

  for (const [geometria, profilo, hex] of casi) {
    it(`legge ${geometria} da un SPS ${profilo}`, () => {
      const unita = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(hex, 'hex'), nal(PPS), nal(IDR)])
      assert.equal(geometriaDi(unita), geometria)
    })
  }

  it('restituisce null su un unita senza SPS', () => {
    assert.equal(geometriaDi(Buffer.concat([nal(PPS), nal(IDR)])), null)
  })

  it('restituisce null su un SPS illeggibile, senza lanciare', () => {
    // Un "SPS" che e solo intestazione e spazzatura: il parser deve arrendersi
    // in silenzio -- un SPS strano non deve far cadere la ripresa.
    const rotto = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67]), Buffer.alloc(3, 0)])
    assert.equal(geometriaDi(rotto), null)
  })
})

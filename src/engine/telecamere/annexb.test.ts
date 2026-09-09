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

import { SpezzatoreAnnexB } from './annexb.js'

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
})

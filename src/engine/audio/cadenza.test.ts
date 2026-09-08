import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Cadenza } from './cadenza.js'

/** Orologio finto: il tempo avanza solo quando lo diciamo noi. */
function orologio(): { ora: () => number; avanza: (ms: number) => void } {
  let t = 1000
  return { ora: () => t, avanza: (ms) => { t += ms } }
}

const BLOCCO = 20
const ANTICIPO = 200
const RECUPERO = 200

function cadenza(o = orologio()) {
  const c = new Cadenza(BLOCCO, ANTICIPO, RECUPERO, o.ora)
  c.avvia()
  return { c, o }
}

describe('cadenza di scrittura', () => {
  it('parte riempiendo subito l anticipo, cosi il Flusso esiste prima degli ascoltatori', () => {
    const { c } = cadenza()
    const primo = c.dovuti()
    assert.equal(primo.blocchi, ANTICIPO / BLOCCO + 1)
    assert.equal(primo.buchiMs, 0)
    assert.equal(c.dovuti().blocchi, 0, 'subito dopo non c e piu niente da scrivere')
  })

  it('produce esattamente un blocco per ogni blocco di tempo trascorso', () => {
    const { c, o } = cadenza()
    c.dovuti()
    for (let i = 0; i < 100; i++) {
      o.avanza(BLOCCO)
      assert.equal(c.dovuti().blocchi, 1)
    }
  })

  it('non accumula deriva quando l orologio non cade sui multipli del blocco', () => {
    // Il caso realistico: il ciclo si sveglia quando gli pare, mai puntuale.
    const { c, o } = cadenza()
    c.dovuti()
    const ritardi = [23, 17, 31, 9, 20, 44, 5, 18, 26, 12]
    let trascorso = 0
    for (let giro = 0; giro < 200; giro++) {
      const d = ritardi[giro % ritardi.length]!
      o.avanza(d)
      trascorso += d
      c.dovuti()
    }
    const dia = c.diagnostica()
    assert.equal(dia.riallineamenti, 0)
    // Restiamo avanti dell anticipo, con al massimo un blocco di tolleranza.
    assert.ok(
      dia.scartoMs >= ANTICIPO - BLOCCO && dia.scartoMs <= ANTICIPO + BLOCCO,
      `deriva fuori tolleranza dopo ${trascorso} ms: scarto ${dia.scartoMs} ms`,
    )
  })

  it('sei ore di Flusso restano in pari al millisecondo', () => {
    // Il criterio §6 chiede sei ore senza riavvio. Con setInterval qui si
    // accumulerebbero minuti: questo test e il motivo per cui non lo usiamo.
    const { c, o } = cadenza()
    c.dovuti()
    const oreInMs = 6 * 60 * 60 * 1000
    let trascorso = 0
    while (trascorso < oreInMs) {
      const d = 15 + ((trascorso * 7919) % 23)
      o.avanza(d)
      trascorso += d
      c.dovuti()
    }
    const dia = c.diagnostica()
    assert.equal(dia.riallineamenti, 0, 'nessuna pausa era abbastanza lunga per riallineare')
    assert.equal(dia.buchiTotaliMs, 0)
    assert.ok(Math.abs(dia.scartoMs - ANTICIPO) <= BLOCCO, `scarto dopo sei ore: ${dia.scartoMs} ms`)
    assert.ok(dia.msProdotti >= oreInMs, 'abbiamo prodotto meno Flusso del tempo passato')
  })

  it('recupera una pausa breve scrivendo i blocchi mancati', () => {
    const { c, o } = cadenza()
    c.dovuti()
    o.avanza(100) // cinque blocchi persi, sotto la soglia di recupero
    const d = c.dovuti()
    assert.equal(d.blocchi, 5)
    assert.equal(d.buchiMs, 0, 'una pausa breve non deve lasciare buchi')
  })

  it('dopo una pausa lunga si riallinea invece di sparare tutto a raffica', () => {
    const { c, o } = cadenza()
    c.dovuti()
    o.avanza(5000) // il portatile si e sospeso
    const d = c.dovuti()

    // Recupero massimo piu il riempimento dell anticipo, e nulla di piu: mai
    // cinque secondi di Flusso sparati dentro il socket tutti insieme.
    assert.equal(d.blocchi, (RECUPERO + ANTICIPO) / BLOCCO)
    // Il resto e perso e va detto: 5000 ms passati, 220 gia prodotti prima,
    // 400 prodotti adesso.
    assert.equal(d.buchiMs, 4600)
    assert.equal(c.diagnostica().riallineamenti, 1)
  })

  it('dopo il riallineamento la cadenza torna regolare al blocco successivo', () => {
    const { c, o } = cadenza()
    c.dovuti()
    o.avanza(5000)
    c.dovuti()

    for (let i = 0; i < 50; i++) {
      o.avanza(BLOCCO)
      assert.equal(c.dovuti().blocchi, 1, `giro ${i} dopo il riallineamento`)
    }
    assert.equal(c.diagnostica().riallineamenti, 1, 'non deve riallinearsi di nuovo')
  })

  it('dorme fino a mezzo anticipo, non un blocco solo', () => {
    // Su Windows la risoluzione dei timer e 15,6 ms: svegliarsi ogni 20 ms
    // significa dormirne 31 e perderne 11 a ogni giro. Misurato: 6,5 s di
    // riallineamento in 12 s di prova.
    const { c, o } = cadenza()
    c.dovuti()
    assert.equal(c.tettoAttesaMs, ANTICIPO / 2)
    const attesa = c.attesaMs()
    assert.ok(attesa > 0 && attesa <= ANTICIPO / 2, `attesa fuori scala: ${attesa}`)

    o.avanza(10_000)
    assert.equal(c.attesaMs(), 0, 'se siamo in ritardo non si aspetta')
  })

  it('con un anticipo minuscolo il tetto non scende sotto un blocco', () => {
    const c = new Cadenza(BLOCCO, 10, RECUPERO, () => 0)
    assert.equal(c.tettoAttesaMs, BLOCCO)
  })

  it('si rifiuta di contare prima di essere avviata', () => {
    const c = new Cadenza(BLOCCO, ANTICIPO, RECUPERO, () => 0)
    assert.equal(c.avviata, false)
    assert.throws(() => c.dovuti(), /non avviata/)
  })

  it('riavviandola riparte pulita', () => {
    const { c, o } = cadenza()
    c.dovuti()
    o.avanza(5000)
    c.dovuti()
    assert.equal(c.diagnostica().riallineamenti, 1)

    c.avvia()
    const dia = c.diagnostica()
    assert.equal(dia.riallineamenti, 0)
    assert.equal(dia.blocchiScritti, 0)
    assert.equal(dia.buchiTotaliMs, 0)
  })
})

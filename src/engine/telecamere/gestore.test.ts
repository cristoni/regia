/**
 * Il preset che Regia applica a una Telecamera appena aggiunta.
 *
 * Sul telefono non torna ai default niente: streaming, risoluzione, zoom,
 * rotazione e torcia restano come li ha lasciati l'ultima volta, anche dopo un
 * riavvio (fatti verificati, android-ip-camera). Quindi il preset non e un
 * dettaglio di cortesia: e l'unico momento in cui Regia sa in che stato si
 * trova il telefono.
 *
 * Qui il telefono e un server HTTP finto, che risponde come risponde quello
 * vero. Non prova il telefono: prova che Regia gli chieda le cose giuste e che
 * sopravviva a quelle che il telefono puo rifiutare.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'

import { progettoVuoto, type Telecamera } from '../dominio/progetto.js'
import { GestoreTelecamere, fpsVisibile } from './gestore.js'

describe('fps in anteprima: mostra il misurato, decade a 0 sullo stallo', () => {
  it('mostra l fps pubblicato mentre i fotogrammi arrivano', () => {
    // Ultimo fotogramma 200 ms fa: lo stream scorre, si mostra il valore vero.
    assert.equal(fpsVisibile(24, 10_000, 10_200), 24)
  })
  it('non ricopia uno 0 di passaggio: e compito del chiamante non passare il parziale', () => {
    // Il fix vive qui: il chiamante passa `fpsPubblicato` (24), non il contatore
    // vivo (che a meta finestra puo essere 0). Con l ultimo fotogramma recente,
    // 24 resta 24 anche se il giro di /info.json capita subito dopo un azzeramento.
    assert.equal(fpsVisibile(24, 10_150, 10_200), 24)
  })
  it('decade a 0 quando lo stream smette di consegnare', () => {
    // Nessun fotogramma da oltre la soglia (2,5 s): non si resta congelati a 24.
    assert.equal(fpsVisibile(24, 5_000, 10_200), 0)
  })
  it('al confine esatto della soglia non e ancora scaduto', () => {
    assert.equal(fpsVisibile(30, 0, 2500), 30)
    assert.equal(fpsVisibile(30, 0, 2501), 0)
  })
})

interface Finto {
  porta: number
  chieste: string[]
  chiudi(): Promise<void>
}

/** Un telefono finto. `rifiuta` elenca i percorsi a cui risponde male. */
async function telefonoFinto(rifiuta: RegExp | null = null): Promise<Finto> {
  const chieste: string[] = []
  const server = http.createServer((req, res) => {
    chieste.push(req.url ?? '')
    if (rifiuta && rifiuta.test(req.url ?? '')) {
      res.writeHead(500).end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const porta = (server.address() as { port: number }).port
  return {
    porta,
    chieste,
    chiudi: () => new Promise<void>((r) => server.close(() => r())),
  }
}

function gestore(righe: string[]): GestoreTelecamere {
  const progetto = progettoVuoto('C:/Video')
  return new GestoreTelecamere({
    progetto: () => progetto,
    suDiario: (livello, testo) => righe.push(`${livello} ${testo}`),
    suFotogramma: () => {},
    password: () => null,
  })
}

function telecamera(porta: number): Telecamera {
  return {
    id: 't1', nome: 'Occhio', host: '127.0.0.1', porta,
    https: false, utente: null, passwordCifrata: null, zonaId: null,
  }
}

describe('il preset di una Telecamera', () => {
  it('accende lo streaming e spegne la torcia', async () => {
    const finto = await telefonoFinto()
    const g = gestore([])
    try {
      await g.preparaTelecamera(telecamera(finto.porta))
      assert.ok(
        finto.chieste.includes('/control/start'),
        `manca /control/start: ${JSON.stringify(finto.chieste)}`,
      )
      assert.ok(
        finto.chieste.some((c) => /^\/\?torch=off$/.test(c)),
        `manca lo spegnimento della torcia: ${JSON.stringify(finto.chieste)}`,
      )
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  /**
   * Un telefono senza flash rifiuta il comando della torcia. Far fallire per
   * questo l'aggiunta di una Telecamera che per il resto funziona sarebbe un
   * pessimo scambio: si scrive nel Diario e si tira avanti.
   */
  it('non fallisce se la torcia non si puo spegnere', async () => {
    const finto = await telefonoFinto(/torch/)
    const righe: string[] = []
    const g = gestore(righe)
    try {
      await g.preparaTelecamera(telecamera(finto.porta))
      assert.ok(
        righe.some((r) => /torcia/.test(r)),
        `il Diario non lo dice: ${JSON.stringify(righe)}`,
      )
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  /** Lo streaming, invece, e la ragione per cui la Telecamera esiste. */
  it('fallisce se lo streaming non si accende', async () => {
    const finto = await telefonoFinto(/control\/start/)
    const g = gestore([])
    try {
      await assert.rejects(() => g.preparaTelecamera(telecamera(finto.porta)), /control\/start/)
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })
})

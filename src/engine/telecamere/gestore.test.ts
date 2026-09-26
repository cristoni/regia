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
import { GestoreTelecamere, fpsVisibile, orientamentoDi, risoluzioneRipresa } from './gestore.js'

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

describe('l orientamento di una geometria (ADR 0013)', () => {
  it('e verticale se l immagine e piu alta che larga', () => {
    assert.equal(orientamentoDi('720x1280'), 'verticale')
    assert.equal(orientamentoDi('1080x1920'), 'verticale')
  })
  it('e orizzontale altrimenti, quadrato compreso', () => {
    assert.equal(orientamentoDi('1280x720'), 'orizzontale')
    assert.equal(orientamentoDi('720x480'), 'orizzontale')
    assert.equal(orientamentoDi('640x640'), 'orizzontale')
  })
  it('non decide su una geometria che non e un WxH', () => {
    assert.equal(orientamentoDi('auto'), null)
    assert.equal(orientamentoDi(''), null)
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
    https: false, utente: null, passwordCifrata: null, zonaId: null, rotazione: 0,
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

/**
 * Regia fissa la geometria del telefono per due ragioni misurate: con
 * `streamRes: "auto"` il telefono la cambia a meta stream e un `-c:v copy` che
 * cambia dimensione blocca i lettori rigidi (ADR 0012); e una geometria che non
 * ha il rapporto dell'obiettivo fa impaginare l'immagine fra bande nere, che
 * sono banda di rete e pixel buttati (ADR 0014). Serve la forma `WxH`: le
 * etichette `low|medium|high` lasciano vivo l'adattamento.
 */
describe('la geometria chiesta al telefono (ADR 0012 e 0014)', () => {
  it('segue il verso del sensore, non quello che vuole l Operatore', () => {
    // Un sensore coricato (90 o 270, cioe quasi tutti i telefoni) da
    // un'immagine verticale: ci vuole un fotogramma verticale, o il telefono
    // la impagina fra bande nere (misurato: 720x960 dentro 1280x960).
    assert.equal(risoluzioneRipresa(90), '960x1280')
    assert.equal(risoluzioneRipresa(270), '960x1280')
    // Un sensore dritto darebbe un'immagine orizzontale.
    assert.equal(risoluzioneRipresa(0), '1280x960')
    assert.equal(risoluzioneRipresa(180), '1280x960')
    // Finche il telefono non ha risposto si tira a indovinare il caso comune.
    assert.equal(risoluzioneRipresa(null), '960x1280')
    // Mai un'etichetta: `low|medium|high` lascerebbero vivo l'adattamento.
    for (const o of [null, 0, 90, 180, 270]) {
      assert.match(risoluzioneRipresa(o), /^\d+x\d+$/)
    }
  })

  it('invia la geometria e lo scrive nel Diario', async () => {
    const finto = await telefonoFinto()
    const righe: string[] = []
    const g = gestore(righe)
    try {
      await g.fissaRisoluzione(telecamera(finto.porta))
      assert.ok(
        finto.chieste.some((c) => /^\/\?resolution=960x1280$/.test(c)),
        `manca il comando della risoluzione: ${JSON.stringify(finto.chieste)}`,
      )
      assert.ok(
        righe.some((r) => /960x1280/.test(r)),
        `il Diario non lo dice: ${JSON.stringify(righe)}`,
      )
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  /**
   * Qui l'errore si propaga, al contrario della torcia del preset: e il
   * registratore a decidere che si registra lo stesso (col taglio-segmento a
   * fare da rete), e per deciderlo deve sapere che il comando e fallito.
   */
  /**
   * La rotazione dichiarata dice come si vuole *vedere* il video, non come il
   * telefono lo *produce*: girare una Telecamera non deve cambiare la
   * geometria chiesta, o si tornerebbe alle bande nere.
   */
  it('non cambia geometria perche la Telecamera e dichiarata girata', async () => {
    const finto = await telefonoFinto()
    const g = gestore([])
    try {
      await g.fissaRisoluzione({ ...telecamera(finto.porta), rotazione: 90 })
      assert.ok(
        finto.chieste.some((c) => /^\/\?resolution=960x1280$/.test(c)),
        `geometria sbagliata: ${JSON.stringify(finto.chieste)}`,
      )
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('propaga l errore se il telefono rifiuta il comando', async () => {
    const finto = await telefonoFinto(/resolution/)
    const g = gestore([])
    try {
      await assert.rejects(() => g.fissaRisoluzione(telecamera(finto.porta)), /risposto 500/)
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })
})

// ---------------------------------------------------------------- ADR 0013

/** Una NAL finta: codice di avvio, intestazione col tipo, riempimento. */
function nal(tipo: number, riempimento = 8): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 1, 0x60 | tipo]), Buffer.alloc(riempimento, tipo)])
}

/**
 * SPS veri, gli stessi di annexb.test: libopenh264 per 1280x720 e 720x1280,
 * libx264 (profilo esteso) per 800x608. Ciascuno finisce dentro un'unita
 * chiave completa SPS+PPS+IDR, come la manda il telefono a ogni secondo.
 */
const SPS_1280x720 = '6742c01f8c6805005bb0101e1108d4'
const SPS_720x1280 = '6742c01f8c680b40a1b0101e1108d4'
const SPS_800x608 = '6764001facd940c8136c0440000003004000000f03c60c6580'

function chiave(spsHex: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(spsHex, 'hex'), nal(8), nal(5)])
}

/**
 * Un telefono che manda video: a ogni `/video/h264` risponde con il prossimo
 * degli elenchi di byte e poi tiene la connessione aperta, perche il flusso
 * vero non finisce mai da solo. Per tutto il resto risponde `{}`, come il
 * finto sopra.
 */
async function telefonoCheManda(flussi: Buffer[][]): Promise<Finto> {
  const chieste: string[] = []
  const aperte = new Set<http.ServerResponse>()
  const server = http.createServer((req, res) => {
    chieste.push(req.url ?? '')
    if (req.url === '/video/h264') {
      res.writeHead(200, { 'content-type': 'video/h264' })
      for (const pezzo of flussi.shift() ?? []) res.write(pezzo)
      aperte.add(res)
      res.on('close', () => aperte.delete(res))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const porta = (server.address() as { port: number }).port
  return {
    porta,
    chieste,
    chiudi: async () => {
      for (const r of aperte) r.destroy()
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

async function finche(condizione: () => boolean, entroMs = 4000): Promise<void> {
  const scadenza = Date.now() + entroMs
  while (!condizione()) {
    if (Date.now() > scadenza) throw new Error('la condizione non si e avverata in tempo')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * Regia si accorge che una Telecamera e stata girata leggendo l'SPS dei
 * fotogrammi chiave, non chiedendolo al telefono (ADR 0013). Qui il telefono
 * finto manda un chiave orizzontale e poi uno verticale, come fa quello vero
 * con la rotazione cotta nel flusso (android-ip-camera 0.13.1).
 */
describe('l orientamento si legge dal video (ADR 0013)', () => {
  function gestoreCon(finto: Finto, righe: string[]): GestoreTelecamere {
    const progetto = progettoVuoto('C:/Video')
    progetto.telecamere.push(telecamera(finto.porta))
    return new GestoreTelecamere({
      progetto: () => progetto,
      suDiario: (livello, testo) => righe.push(`${livello} ${testo}`),
      suFotogramma: () => {},
      password: () => null,
    })
  }

  it('un chiave che scambia gli assi finisce nel Diario e nello stato', async () => {
    // L'unita chiave esce dallo spezzatore solo all'arrivo del codice di avvio
    // successivo: la slice in coda serve a far uscire il secondo chiave.
    const finto = await telefonoCheManda([[chiave(SPS_1280x720), chiave(SPS_720x1280), nal(1)]])
    const righe: string[] = []
    const g = gestoreCon(finto, righe)
    try {
      g.avvia()
      g.vuoleAnteprima(['t1'])
      await finche(() => g.viva('t1')?.orientamento === 'verticale')
      const v = g.viva('t1')!
      assert.equal(v.geometria, '720x1280')
      assert.ok(v.orientamentoCambiatoIl, 'l istante del cambio deve esserci')
      const riga = righe.find((r) => /ruotat/.test(r))
      assert.ok(riga, `il Diario non lo dice: ${JSON.stringify(righe)}`)
      // Dice cio che si e misurato -- il fotogramma -- e non come sta
      // l'immagine dentro, che da un SPS non si vede (ADR 0013, correzione).
      assert.match(riga, /^attenzione Il video di "Occhio" ha ruotato: il fotogramma e passato da 1280x720 a 720x1280\./)
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('un cambio di geometria che non cambia verso non fa rumore', async () => {
    // E il caso di `streamRes: "auto"` (ADR 0012): la geometria cambia a ogni
    // rebind senza che nessuno abbia toccato il telefono.
    const finto = await telefonoCheManda([[chiave(SPS_1280x720), chiave(SPS_800x608), nal(1)]])
    const righe: string[] = []
    const g = gestoreCon(finto, righe)
    try {
      g.avvia()
      g.vuoleAnteprima(['t1'])
      await finche(() => g.viva('t1')?.geometria === '800x608')
      const v = g.viva('t1')!
      assert.equal(v.orientamento, 'orizzontale')
      assert.equal(v.orientamentoCambiatoIl, null)
      assert.ok(!righe.some((r) => /ruotat/.test(r)), `Diario sporco: ${JSON.stringify(righe)}`)
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('lo dice anche se il telefono e stato girato mentre nessuno guardava', async () => {
    // Prima sessione orizzontale; l'anteprima si chiude; la seconda sessione
    // trova un chiave verticale. La memoria della geometria sopravvive alla
    // sessione apposta: il cambio si dice al primo momento in cui si puo.
    const finto = await telefonoCheManda([
      [chiave(SPS_1280x720), nal(1)],
      [chiave(SPS_720x1280), nal(1)],
    ])
    const righe: string[] = []
    const g = gestoreCon(finto, righe)
    try {
      g.avvia()
      g.vuoleAnteprima(['t1'])
      await finche(() => g.viva('t1')?.geometria === '1280x720')
      g.vuoleAnteprima([])
      assert.equal(g.viva('t1')?.orientamento, 'orizzontale', 'la memoria resta a flusso chiuso')
      g.vuoleAnteprima(['t1'])
      await finche(() => g.viva('t1')?.orientamento === 'verticale')
      assert.ok(righe.some((r) => /ruotat/.test(r)), `il Diario non lo dice: ${JSON.stringify(righe)}`)
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })
})

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

/**
 * Un telefono finto per la torcia: scrive quando ogni richiesta **arriva** e
 * quando ha **risposto**, perche la cosa da provare e l'ordine in cui il
 * telefono vede `on` e `off`. `lento` ritarda la risposta alle richieste che
 * combaciano; `rifiuta` risponde 500.
 */
async function telefonoConTorcia(
  opzioni: {
    rifiuta?: RegExp
    lento?: RegExp
    ritardoMs?: number
    haFlash?: boolean
    /** La torcia com'e all'accensione del finto: persistente, come sul telefono vero. */
    torciaAccesa?: boolean
    /**
     * Esegue il comando lento solo allo scadere del ritardo, e non appena
     * arriva: e il comando che il telefono riceve tardi, non quello a cui
     * risponde tardi.
     */
    eseguiPrimaDiRispondere?: boolean
  } = {},
): Promise<Finto & { eventi: string[]; torcia(): string[]; stato(): string }> {
  const chieste: string[] = []
  const eventi: string[] = []
  let stato = opzioni.torciaAccesa ? 'on' : 'off'
  const esegui = (url: string): void => {
    const v = /torch=(\w+)/.exec(url)?.[1]
    if (v && !opzioni.rifiuta?.test(url)) stato = v
  }
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    chieste.push(url)
    eventi.push(`arriva ${url}`)
    const lento = opzioni.lento?.test(url) ?? false
    if (!(lento && opzioni.eseguiPrimaDiRispondere)) esegui(url)
    const rispondi = (): void => {
      if (lento && opzioni.eseguiPrimaDiRispondere) esegui(url)
      eventi.push(`risposto ${url}`)
      if (res.destroyed) return
      if (opzioni.rifiuta?.test(url)) {
        res.writeHead(500).end('no')
        return
      }
      const corpo =
        url === '/info.json'
          ? JSON.stringify({ settings: { deviceHasFlash: opzioni.haFlash ?? true, torch: stato } })
          : 'OK'
      res.writeHead(200, { 'content-type': 'application/json' }).end(corpo)
    }
    if (lento) setTimeout(rispondi, opzioni.ritardoMs ?? 200)
    else rispondi()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const porta = (server.address() as { port: number }).port
  return {
    porta,
    chieste,
    eventi,
    torcia: () => chieste.filter((c) => /torch=/.test(c)).map((c) => c.replace('/?torch=', '')),
    stato: () => stato,
    chiudi: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

const aspetta = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Il Lampo: la torcia accesa per una durata, e spenta da Regia (flash, 1 sec,
 * 5 sec sulla griglia; Identifica e un Lampo di due secondi). Quello che si
 * prova e cio che rende pericolosa una torcia: che si spenga sempre, e che
 * l'`off` non arrivi mai al telefono prima dell'`on` a cui risponde.
 */
describe('il Lampo della torcia', () => {
  function gestoreCon(porta: number, righe: string[] = []): GestoreTelecamere {
    const progetto = progettoVuoto('C:/Video')
    progetto.telecamere.push(telecamera(porta))
    return new GestoreTelecamere({
      progetto: () => progetto,
      suDiario: (livello, testo) => righe.push(`${livello} ${testo}`),
      suFotogramma: () => {},
      password: () => null,
    })
  }

  it('accende subito e spegne da solo dopo la durata', async () => {
    const finto = await telefonoConTorcia()
    const g = gestoreCon(finto.porta)
    try {
      await g.lampo('t1', 150)
      // Il comando torna alla conferma dell'accensione, non alla fine.
      assert.deepEqual(finto.torcia(), ['on'])
      await aspetta(80)
      assert.deepEqual(finto.torcia(), ['on'], 'spenta prima del tempo')
      await finche(() => finto.torcia().length === 2)
      assert.deepEqual(finto.torcia(), ['on', 'off'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('la durata si conta dalla conferma del telefono, non dalla richiesta', async () => {
    // Un telefono lento a rispondere non deve mangiarsi il Lampo: con 300 ms
    // di ritardo e un Lampo di 150, contare dalla richiesta spegnerebbe la
    // torcia 150 ms prima ancora che il telefono dica di averla accesa.
    const finto = await telefonoConTorcia({ lento: /torch=on/, ritardoMs: 300 })
    const g = gestoreCon(finto.porta)
    try {
      const prima = Date.now()
      await g.lampo('t1', 150)
      assert.ok(Date.now() - prima >= 280, 'il comando non ha aspettato la conferma')
      await finche(() => finto.torcia().length === 2)
      const i = finto.eventi.indexOf('risposto /?torch=on')
      const j = finto.eventi.indexOf('arriva /?torch=off')
      assert.ok(i >= 0 && j > i, `ordine sbagliato: ${JSON.stringify(finto.eventi)}`)
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('un Lampo nuovo sposta lo spegnimento invece di spegnere e riaccendere', async () => {
    const finto = await telefonoConTorcia()
    const g = gestoreCon(finto.porta)
    try {
      await g.lampo('t1', 150)
      await aspetta(50)
      await g.lampo('t1', 400)
      // Passata la scadenza del primo: la torcia deve essere ancora accesa.
      await aspetta(200)
      assert.ok(!finto.torcia().includes('off'), `spenta dal primo Lampo: ${finto.torcia()}`)
      await finche(() => finto.torcia().includes('off'))
      await aspetta(100)
      assert.deepEqual(finto.torcia(), ['on', 'on', 'off'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('un flash durante un 5 sec lo accorcia: vale l ultimo clic', async () => {
    const finto = await telefonoConTorcia()
    const g = gestoreCon(finto.porta)
    try {
      await g.lampo('t1', 5000)
      await g.lampo('t1', 100)
      await finche(() => finto.torcia().includes('off'), 1000)
      await aspetta(100)
      assert.deepEqual(finto.torcia(), ['on', 'on', 'off'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('lo stato dice quale Lampo tiene accesa la torcia, e smette quando si spegne', async () => {
    const finto = await telefonoConTorcia()
    const g = gestoreCon(finto.porta)
    try {
      g.avvia()
      await finche(() => g.viva('t1')?.raggiungibile === true)
      assert.equal(g.viva('t1')?.lampoMs, null)
      await g.lampo('t1', 200)
      assert.equal(g.viva('t1')?.lampoMs, 200)
      await finche(() => g.viva('t1')?.lampoMs === null, 1000)
      assert.deepEqual(finto.torcia(), ['on', 'off'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('rifiuta su un telefono che ha detto di non avere il flash', async () => {
    const finto = await telefonoConTorcia({ haFlash: false })
    const g = gestoreCon(finto.porta)
    try {
      g.avvia()
      await finche(() => g.viva('t1')?.raggiungibile === true)
      await assert.rejects(() => g.lampo('t1', 300), /non ha il flash/)
      assert.deepEqual(finto.torcia(), [], 'al telefono non deve arrivare niente')
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('se l accensione fallisce lo dice, e spegne lo stesso', async () => {
    // Una risposta persa non prova che il telefono non abbia eseguito: la
    // torcia potrebbe essere accesa, e una accesa per sbaglio resta accesa.
    const finto = await telefonoConTorcia({ rifiuta: /torch=on/ })
    const g = gestoreCon(finto.porta)
    try {
      await assert.rejects(() => g.lampo('t1', 5000), /500/)
      await finche(() => finto.torcia().includes('off'), 1000)
      assert.deepEqual(finto.torcia(), ['on', 'off'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('riprova a spegnere, e se non ci riesce lo scrive nel Diario', async () => {
    const finto = await telefonoConTorcia({ rifiuta: /torch=off/ })
    const righe: string[] = []
    const g = gestoreCon(finto.porta, righe)
    try {
      await g.lampo('t1', 50)
      await finche(() => righe.some((r) => /rimasta accesa/.test(r)), 4000)
      assert.deepEqual(finto.torcia(), ['on', 'off', 'off', 'off'])
      assert.ok(righe.some((r) => /^attenzione /.test(r)), JSON.stringify(righe))
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('chiudere Regia a torcia accesa la spegne, dopo l accensione in volo', async () => {
    // L'`on` e ancora in viaggio quando Regia si chiude: l'`off` deve
    // arrivare al telefono dopo, o il telefono lo riceverebbe per primo e la
    // torcia resterebbe accesa -- e sul telefono e persistente.
    const finto = await telefonoConTorcia({ lento: /torch=on/, ritardoMs: 200 })
    const g = gestoreCon(finto.porta)
    try {
      const inVolo = g.lampo('t1', 5000)
      await finche(() => finto.torcia().length === 1)
      await g.chiudi()
      await inVolo
      assert.deepEqual(finto.torcia(), ['on', 'off'])
      const i = finto.eventi.indexOf('risposto /?torch=on')
      const j = finto.eventi.indexOf('arriva /?torch=off')
      assert.ok(i >= 0 && j > i, `ordine sbagliato: ${JSON.stringify(finto.eventi)}`)
      // E dopo non si riaccende niente: il Lampo in volo non riprogramma.
      await aspetta(150)
      assert.deepEqual(finto.torcia(), ['on', 'off'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('Identifica e un Lampo: un Lampo premuto durante non viene tagliato', async () => {
    const finto = await telefonoConTorcia()
    const g = gestoreCon(finto.porta)
    try {
      const identifica = g.identifica('t1')
      await finche(() => finto.torcia().length === 1)
      await g.lampo('t1', 5000)
      await identifica
      await aspetta(100)
      // Due secondi dopo Identifica non ha spento la torcia del "5 sec".
      assert.deepEqual(finto.torcia(), ['on', 'on'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
    assert.deepEqual(finto.torcia(), ['on', 'on', 'off'], 'chiudere deve spegnerla')
  })

  it('Identifica da sola si spegne dopo due secondi', async () => {
    const finto = await telefonoConTorcia()
    const g = gestoreCon(finto.porta)
    try {
      await g.identifica('t1')
      await finche(() => finto.torcia().length === 2, 1000)
      assert.deepEqual(finto.torcia(), ['on', 'off'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })
})

/**
 * Le tre correzioni della revisione del 26 settembre 2026: la torcia e del
 * telefono e non dell'id, una torcia dimenticata si rispegne al giro di
 * `/info.json`, e l'Identifica finisce quando un Lampo le prende la torcia.
 */
describe('la torcia e del telefono, e non resta accesa', () => {
  function gestoreSu(progetto: ReturnType<typeof progettoVuoto>, righe: string[] = []): GestoreTelecamere {
    return new GestoreTelecamere({
      progetto: () => progetto,
      suDiario: (livello, testo) => righe.push(`${livello} ${testo}`),
      suFotogramma: () => {},
      password: () => null,
    })
  }

  it('un progetto importato che riusa l id non ruba lo spegnimento al telefono di prima', async () => {
    // `t1` e il telefono A; si importa un progetto in cui `t1` e il telefono
    // B, e si preme un Lampo su `t1`. A deve spegnersi lo stesso.
    const A = await telefonoConTorcia()
    const B = await telefonoConTorcia()
    let progetto = progettoVuoto('C:/Video')
    progetto.telecamere.push(telecamera(A.porta))
    const g = new GestoreTelecamere({
      progetto: () => progetto,
      suDiario: () => {},
      suFotogramma: () => {},
      password: () => null,
    })
    try {
      await g.lampo('t1', 300)
      const importato = progettoVuoto('C:/Video')
      importato.telecamere.push(telecamera(B.porta))
      progetto = importato
      g.sincronizza()
      await g.lampo('t1', 100)
      await finche(() => A.torcia().includes('off') && B.torcia().includes('off'), 1500)
      assert.deepEqual(A.torcia(), ['on', 'off'])
      assert.deepEqual(B.torcia(), ['on', 'off'])
    } finally {
      await g.chiudi()
      await A.chiudi()
      await B.chiudi()
    }
  })

  it('una torcia accesa senza un Lampo si spegne al giro di /info.json, e lo si dice', async () => {
    // E il caso di Regia morta a torcia accesa: sul telefono la torcia e
    // persistente, e alla riapertura nessun Lampo la sta tenendo accesa.
    const finto = await telefonoConTorcia({ torciaAccesa: true })
    const righe: string[] = []
    const progetto = progettoVuoto('C:/Video')
    progetto.telecamere.push(telecamera(finto.porta))
    const g = gestoreSu(progetto, righe)
    try {
      g.avvia()
      await finche(() => finto.torcia().includes('off'))
      assert.deepEqual(finto.torcia(), ['off'])
      await finche(() => righe.some((r) => /era accesa senza un Lampo/.test(r)))
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('non spegne la torcia di un Lampo in corso', async () => {
    const finto = await telefonoConTorcia({ torciaAccesa: true })
    const progetto = progettoVuoto('C:/Video')
    progetto.telecamere.push(telecamera(finto.porta))
    const g = gestoreSu(progetto)
    try {
      await g.lampo('t1', 5000)
      g.avvia()
      await finche(() => g.viva('t1')?.raggiungibile === true)
      await aspetta(100)
      assert.deepEqual(finto.torcia(), ['on'], 'ha spento il Lampo')
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('l on scaduto che arriva dopo il suo off viene ripreso dal giro dopo', async () => {
    // Il telefono esegue l'`on` quattro secondi dopo averlo ricevuto -- come un
    // segmento ritrasmesso dopo un buco del Wi-Fi -- quando Regia ha gia
    // rinunciato e mandato l'`off`. Senza `rispegni` la torcia restava accesa.
    const finto = await telefonoConTorcia({ lento: /torch=on/, ritardoMs: 4000, eseguiPrimaDiRispondere: true })
    const righe: string[] = []
    const progetto = progettoVuoto('C:/Video')
    progetto.telecamere.push(telecamera(finto.porta))
    const g = gestoreSu(progetto, righe)
    try {
      g.avvia()
      await finche(() => g.viva('t1')?.raggiungibile === true)
      await assert.rejects(() => g.lampo('t1', 1000), /nessuna risposta/)
      await finche(() => finto.stato() === 'on', 3000)
      // Qui la torcia e accesa e Regia la crede spenta: tocca al giro.
      await finche(() => finto.stato() === 'off', 8000)
      assert.ok(righe.some((r) => /era accesa senza un Lampo/.test(r)), JSON.stringify(righe))
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('Identifica smette di dirsi in corso quando un Lampo le prende la torcia', async () => {
    const finto = await telefonoConTorcia()
    const progetto = progettoVuoto('C:/Video')
    progetto.telecamere.push(telecamera(finto.porta))
    const g = gestoreSu(progetto)
    try {
      g.avvia()
      await finche(() => g.viva('t1')?.raggiungibile === true)
      const identifica = g.identifica('t1')
      await finche(() => finto.torcia().length === 1)
      assert.equal(g.viva('t1')?.inIdentificazione, true)
      await g.lampo('t1', 100)
      assert.equal(g.viva('t1')?.inIdentificazione, false)
      // E se ne puo chiedere un'altra subito, senza aspettare i due secondi.
      await g.identifica('t1')
      await identifica
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })
})

/**
 * Il pulsante on/off: la torcia accesa finche non la si spegne. E un Lampo
 * senza scadenza, quindi segue le regole dei Lampi -- e la rete di sicurezza
 * che spegne le torce dimenticate non deve scambiarla per una di quelle.
 */
describe('la torcia fissa, dal pulsante on/off', () => {
  function gestoreSu(porta: number, righe: string[] = []): GestoreTelecamere {
    const progetto = progettoVuoto('C:/Video')
    progetto.telecamere.push(telecamera(porta))
    return new GestoreTelecamere({
      progetto: () => progetto,
      suDiario: (livello, testo) => righe.push(`${livello} ${testo}`),
      suFotogramma: () => {},
      password: () => null,
    })
  }

  it('resta accesa finche non la si spegne, e lo stato lo dice', async () => {
    const finto = await telefonoConTorcia()
    const g = gestoreSu(finto.porta)
    try {
      g.avvia()
      await finche(() => g.viva('t1')?.raggiungibile === true)
      await g.torcia('t1', true)
      assert.equal(g.viva('t1')?.torciaFissa, true)
      assert.equal(g.viva('t1')?.lampoMs, null)
      // Piu di un giro di /info.json: ne un timer ne `rispegni` la toccano.
      await aspetta(3500)
      assert.deepEqual(finto.torcia(), ['on'])
      await g.torcia('t1', false)
      assert.deepEqual(finto.torcia(), ['on', 'off'])
      assert.equal(g.viva('t1')?.torciaFissa, false)
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('un Lampo premuto dopo la riprende, e alla fine del suo tempo la spegne', async () => {
    const finto = await telefonoConTorcia()
    const g = gestoreSu(finto.porta)
    try {
      await g.torcia('t1', true)
      await g.lampo('t1', 100)
      await finche(() => finto.torcia().includes('off'), 1000)
      assert.deepEqual(finto.torcia(), ['on', 'on', 'off'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('accesa durante un Lampo, il Lampo non la spegne piu', async () => {
    const finto = await telefonoConTorcia()
    const g = gestoreSu(finto.porta)
    try {
      await g.lampo('t1', 150)
      await g.torcia('t1', true)
      await aspetta(350)
      assert.deepEqual(finto.torcia(), ['on', 'on'])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
    assert.deepEqual(finto.torcia(), ['on', 'on', 'off'], 'chiudere Regia la spegne')
  })

  it('spegne anche una torcia che Regia non sapeva accesa', async () => {
    // Chi preme "spegni" vede una luce: da dove venga non conta.
    const finto = await telefonoConTorcia({ torciaAccesa: true })
    const g = gestoreSu(finto.porta)
    try {
      await g.torcia('t1', false)
      assert.deepEqual(finto.torcia(), ['off'])
      assert.equal(finto.stato(), 'off')
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })

  it('rifiuta di accendersi su un telefono senza flash', async () => {
    const finto = await telefonoConTorcia({ haFlash: false })
    const g = gestoreSu(finto.porta)
    try {
      g.avvia()
      await finche(() => g.viva('t1')?.raggiungibile === true)
      await assert.rejects(() => g.torcia('t1', true), /non ha il flash/)
      assert.deepEqual(finto.torcia(), [])
    } finally {
      await g.chiudi()
      await finto.chiudi()
    }
  })
})

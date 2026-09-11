import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, it } from 'node:test'

import { WebSocket } from 'ws'

import { latenzaAttesaMs, progettoVuoto } from '../dominio/progetto.js'
import { impacchettaVideo, spacchettaVideo, type Comando, type Evento, type Stato } from './protocollo.js'
import { OPZIONI_PREDEFINITE, Servitore, type Motore } from './servitore.js'

const daPulire: Array<() => Promise<void>> = []
after(async () => {
  for (const f of daPulire.reverse()) await f().catch(() => {})
})

function statoFinto(nome = 'Casa degli orrori'): Stato {
  const p = progettoVuoto('C:/Video')
  return {
    progettoNome: nome,
    server: 'acceso',
    zone: [], altoparlanti: [], telecamere: [], suoni: [], avvisi: [],
    registrazione: { attive: 0, spazioLiberoGb: 100, sottoAvviso: false, bloccata: false, cartella: 'C:/Video' },
    audio: { bufferMs: 2000, codec: 'pcm', bandaMbit: 0 },
    impostazioni: { audio: p.audio, server: p.server, registrazione: p.registrazione },
    ambiente: {
      piattaforma: 'windows', sede: 'sconosciuta', sedeDescrizione: '', sedeMotivo: null,
      sedeRimedio: null, distro: null, snapserver: null, snapserverVecchio: false,
      ffmpeg: null, porteOccupate: [], indirizzi: [], controllatoIl: null,
    },
    latenzaAttesaMs: latenzaAttesaMs(p.audio),
  }
}

class MotoreFinto implements Motore {
  eseguiti: Comando[] = []
  daFallire: string | null = null
  suoniImportati: { nome: string; byte: number }[] = []
  progettoImportato: string | null = null
  private nome = 'Casa degli orrori'
  private video: ((id: string, chiave: boolean, d: Uint8Array) => void)[] = []
  private diario: ((e: Extract<Evento, { tipo: 'diario' }>) => void)[] = []

  stato(): Stato {
    return statoFinto(this.nome)
  }
  async esegui(c: Comando): Promise<void> {
    if (this.daFallire) throw new Error(this.daFallire)
    this.eseguiti.push(c)
    if (c.tipo === 'zona.rinomina') this.nome = c.nome
  }
  ascoltaVideo(a: (id: string, chiave: boolean, d: Uint8Array) => void): () => void {
    this.video.push(a)
    return () => (this.video = this.video.filter((x) => x !== a))
  }
  ascoltaDiario(a: (e: Extract<Evento, { tipo: 'diario' }>) => void): () => void {
    this.diario.push(a)
    return () => (this.diario = this.diario.filter((x) => x !== a))
  }
  interessatoVideo(): void {}
  ultimoIdr(): Uint8Array | null {
    return null
  }
  async elencoRegistrazioni(): Promise<readonly unknown[]> {
    return []
  }
  async importaSuono(nome: string, dati: Buffer): Promise<void> {
    if (this.daFallire) throw new Error(this.daFallire)
    this.suoniImportati.push({ nome, byte: dati.length })
  }
  async esportaProgetto(): Promise<string> {
    return '{"nome":"finto"}'
  }
  async importaProgettoDaTesto(testo: string): Promise<void> {
    if (this.daFallire) throw new Error(this.daFallire)
    this.progettoImportato = testo
  }
  emettiVideo(id: string, chiave: boolean, d: Uint8Array): void {
    for (const a of this.video) a(id, chiave, d)
  }
  emettiDiario(testo: string): void {
    for (const a of this.diario)
      a({ tipo: 'diario', quando: '2026-09-08T00:00:00.000Z', livello: 'info', testo })
  }
}

async function avvia(opzioni: Partial<typeof OPZIONI_PREDEFINITE> = {}) {
  const motore = new MotoreFinto()
  const s = new Servitore(motore, { ...OPZIONI_PREDEFINITE, porta: 0, cadenzaStatoMs: 20, ...opzioni })
  const porta = await s.avvia()
  daPulire.push(() => s.ferma())
  return { motore, servitore: s, porta }
}

/** Un client di prova: raccoglie eventi e sa aspettarne uno che soddisfa un test. */
class Client {
  readonly eventi: Evento[] = []
  readonly binari: Uint8Array[] = []
  private constructor(private readonly ws: WebSocket) {}

  static async collega(porta: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${porta}/regia`)
    const c = new Client(ws)
    ws.on('message', (d, binario) => {
      if (binario) c.binari.push(new Uint8Array(d as Buffer))
      else c.eventi.push(JSON.parse(d.toString()) as Evento)
    })
    await new Promise((ok, ko) => {
      ws.once('open', ok)
      ws.once('error', ko)
    })
    daPulire.push(async () => ws.close())
    return c
  }

  manda(x: unknown): void {
    this.ws.send(JSON.stringify(x))
  }
  mandaGrezzo(s: string): void {
    this.ws.send(s)
  }

  async aspetta<T extends Evento>(prova: (e: Evento) => e is T, entro?: number): Promise<T>
  async aspetta(prova: (e: Evento) => boolean, entro?: number): Promise<Evento>
  async aspetta(prova: (e: Evento) => boolean, entro = 2000): Promise<Evento> {
    const scadenza = Date.now() + entro
    for (;;) {
      const trovato = this.eventi.find(prova)
      if (trovato) return trovato
      if (Date.now() > scadenza) throw new Error(`evento mai arrivato; ricevuti: ${JSON.stringify(this.eventi).slice(0, 400)}`)
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  async aspettaBinario(entro = 2000): Promise<Uint8Array> {
    const scadenza = Date.now() + entro
    while (this.binari.length === 0) {
      if (Date.now() > scadenza) throw new Error('nessun messaggio binario')
      await new Promise((r) => setTimeout(r, 5))
    }
    return this.binari[0]!
  }
  chiudi(): void {
    this.ws.close()
  }
}

describe('servitore: stato', () => {
  it('manda l istantanea completa appena un client si collega', async () => {
    const { porta } = await avvia()
    const c = await Client.collega(porta)
    const e = await c.aspetta((x) => x.tipo === 'stato')
    assert.equal(e.tipo, 'stato')
    if (e.tipo !== 'stato') return
    assert.equal(e.stato.progettoNome, 'Casa degli orrori')
  })

  it('non rimanda la stessa istantanea a ogni battito', async () => {
    const { porta } = await avvia({ cadenzaStatoMs: 10 })
    const c = await Client.collega(porta)
    await c.aspetta((x) => x.tipo === 'stato')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(
      c.eventi.filter((e) => e.tipo === 'stato').length,
      1,
      'lo stato immutato non deve essere ritrasmesso quindici volte',
    )
  })

  it('trasmette subito dopo un comando, senza aspettare il battito', async () => {
    const { porta } = await avvia({ cadenzaStatoMs: 5000 })
    const c = await Client.collega(porta)
    await c.aspetta((x) => x.tipo === 'stato')

    c.manda({ tipo: 'comando', id: 'c1', comando: { tipo: 'zona.rinomina', zonaId: 'z1', nome: 'Cripta' } })
    const e = await c.aspetta((x) => x.tipo === 'stato' && x.stato.progettoNome === 'Cripta', 1000)
    assert.equal(e.tipo, 'stato')
  })

  it('due client vedono lo stesso stato', async () => {
    const { porta } = await avvia()
    const a = await Client.collega(porta)
    const b = await Client.collega(porta)
    await a.aspetta((x) => x.tipo === 'stato')

    a.manda({ tipo: 'comando', id: 'c1', comando: { tipo: 'zona.rinomina', zonaId: 'z1', nome: 'Soffitta' } })
    await b.aspetta((x) => x.tipo === 'stato' && x.stato.progettoNome === 'Soffitta')
  })
})

describe('servitore: comandi', () => {
  it('esegue un comando valido e conferma', async () => {
    const { motore, porta } = await avvia()
    const c = await Client.collega(porta)
    c.manda({ tipo: 'comando', id: 'abc', comando: { tipo: 'stopTutto' } })

    const e = await c.aspetta((x) => x.tipo === 'esito')
    assert.deepEqual(e, { tipo: 'esito', id: 'abc', ok: true })
    assert.deepEqual(motore.eseguiti, [{ tipo: 'stopTutto' }])
  })

  it('rifiuta un comando malformato spiegando cosa manca', async () => {
    const { motore, porta } = await avvia()
    const c = await Client.collega(porta)
    c.manda({ tipo: 'comando', id: 'x1', comando: { tipo: 'zona.suona' } })

    const e = await c.aspetta((x) => x.tipo === 'esito' && !x.ok)
    assert.equal(e.tipo === 'esito' && e.ok, false)
    assert.deepEqual(motore.eseguiti, [], 'un comando invalido non deve arrivare al motore')
  })

  it('un comando che fallisce non butta giu la connessione', async () => {
    const { motore, porta } = await avvia()
    const c = await Client.collega(porta)
    motore.daFallire = 'il server audio e spento'

    c.manda({ tipo: 'comando', id: 'k1', comando: { tipo: 'stopTutto' } })
    const e = await c.aspetta((x) => x.tipo === 'esito' && x.id === 'k1')
    assert.equal(e.tipo === 'esito' && e.ok === false && e.errore, 'il server audio e spento')

    // E la connessione regge il comando successivo.
    motore.daFallire = null
    c.manda({ tipo: 'comando', id: 'k2', comando: { tipo: 'stopTutto' } })
    await c.aspetta((x) => x.tipo === 'esito' && x.id === 'k2' && x.ok)
  })

  it('sopravvive a spazzatura che non e nemmeno JSON', async () => {
    const { porta } = await avvia()
    const c = await Client.collega(porta)
    c.mandaGrezzo('{{{ non sono json')
    await c.aspetta((x) => x.tipo === 'esito' && !x.ok)

    c.manda({ tipo: 'comando', id: 'dopo', comando: { tipo: 'stopTutto' } })
    await c.aspetta((x) => x.tipo === 'esito' && x.id === 'dopo' && x.ok)
  })
})

describe('servitore: video', () => {
  it('non manda fotogrammi a chi non si e iscritto', async () => {
    const { motore, porta } = await avvia()
    const c = await Client.collega(porta)
    await c.aspetta((x) => x.tipo === 'stato')

    motore.emettiVideo('cam-1', true, new Uint8Array([1, 2, 3]))
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(c.binari.length, 0)
  })

  it('manda solo le Telecamere richieste, impacchettate', async () => {
    const { motore, porta } = await avvia()
    const c = await Client.collega(porta)
    await c.aspetta((x) => x.tipo === 'stato')

    c.manda({ tipo: 'video.iscrivi', telecamere: ['cam-1'] })
    await new Promise((r) => setTimeout(r, 50))

    motore.emettiVideo('cam-2', true, new Uint8Array([9, 9]))
    motore.emettiVideo('cam-1', true, new Uint8Array([1, 2, 3, 4]))

    const b = await c.aspettaBinario()
    const letto = spacchettaVideo(b)
    assert.deepEqual(letto, { telecameraId: 'cam-1', chiave: true, dati: new Uint8Array([1, 2, 3, 4]) })
    assert.equal(c.binari.length, 1, 'cam-2 non doveva arrivare')
  })

  it('due client possono volere Telecamere diverse', async () => {
    const { motore, porta } = await avvia()
    const a = await Client.collega(porta)
    const b = await Client.collega(porta)
    a.manda({ tipo: 'video.iscrivi', telecamere: ['cam-1', 'cam-2'] })
    b.manda({ tipo: 'video.iscrivi', telecamere: ['cam-2'] })
    await new Promise((r) => setTimeout(r, 50))

    motore.emettiVideo('cam-1', false, new Uint8Array([1]))
    motore.emettiVideo('cam-2', false, new Uint8Array([2]))
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(a.binari.length, 2)
    assert.equal(b.binari.length, 1)
    assert.equal(spacchettaVideo(b.binari[0]!)?.telecameraId, 'cam-2')
  })

  it('l impacchettamento regge identificativi con accenti', () => {
    // Il nome viaggia in UTF-8 e la lunghezza e in byte, non in caratteri:
    // contarla in caratteri taglierebbe il payload a ogni accento.
    const dati = new Uint8Array([0, 0, 0, 1, 0x65])
    const letto = spacchettaVideo(impacchettaVideo('Telecamera perché', false, dati))
    assert.equal(letto?.telecameraId, 'Telecamera perché')
    // `dati` e una vista senza copia sul pacchetto, di proposito: si confronta
    // il contenuto, non il prototipo.
    assert.deepEqual(Array.from(letto!.dati), Array.from(dati))
  })

  it('rifiuta un pacchetto binario troncato invece di leggere a caso', () => {
    assert.equal(spacchettaVideo(new Uint8Array([1, 0])), null)
    assert.equal(spacchettaVideo(new Uint8Array([1, 0, 0, 50, 0x61])), null)
    assert.equal(spacchettaVideo(new Uint8Array([99, 0, 0, 0])), null)
  })
})

describe('servitore: diario e file', () => {
  it('gira le righe di diario a tutti i client', async () => {
    const { motore, porta } = await avvia()
    const a = await Client.collega(porta)
    const b = await Client.collega(porta)
    motore.emettiDiario('Il telefono della cantina non risponde')

    for (const c of [a, b]) {
      const e = await c.aspetta((x) => x.tipo === 'diario')
      assert.equal(e.tipo === 'diario' && e.testo, 'Il telefono della cantina non risponde')
    }
  })

  it('non serve file fuori dalla cartella dell interfaccia', async () => {
    const radice = await fs.mkdtemp(path.join(os.tmpdir(), 'regia-ui-'))
    daPulire.push(() => fs.rm(radice, { recursive: true, force: true }))
    await fs.writeFile(path.join(radice, 'index.html'), '<h1>Regia</h1>')
    await fs.writeFile(path.join(path.dirname(radice), 'segreto.txt'), 'password')

    const { porta } = await avvia({ cartellaUi: radice })
    const fuori = await fetch(`http://127.0.0.1:${porta}/../segreto.txt`)
    assert.notEqual(await fuori.text(), 'password')

    const dentro = await fetch(`http://127.0.0.1:${porta}/`)
    assert.equal(await dentro.text(), '<h1>Regia</h1>')
  })

  it('risponde a /salute anche senza interfaccia', async () => {
    const { porta } = await avvia()
    const r = await fetch(`http://127.0.0.1:${porta}/salute`)
    assert.deepEqual(await r.json(), { ok: true, clienti: 0 })
  })

  it('importa un Suono via POST, e un fallimento del motore diventa un 400', async () => {
    const { motore, porta } = await avvia()
    const ok = await fetch(`http://127.0.0.1:${porta}/api/suoni?nome=urlo.wav`, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(motore.suoniImportati, [{ nome: 'urlo.wav', byte: 3 }])

    motore.daFallire = 'file non valido'
    const male = await fetch(`http://127.0.0.1:${porta}/api/suoni?nome=x`, { method: 'POST', body: 'x' })
    assert.equal(male.status, 400)
    assert.deepEqual(await male.json(), { errore: 'file non valido' })
  })

  it('esporta e importa il progetto via /api/progetto', async () => {
    const { motore, porta } = await avvia()
    const esporta = await fetch(`http://127.0.0.1:${porta}/api/progetto`)
    assert.equal(await esporta.text(), '{"nome":"finto"}')

    const importa = await fetch(`http://127.0.0.1:${porta}/api/progetto`, { method: 'POST', body: '{"v":1}' })
    assert.equal(importa.status, 200)
    assert.equal(motore.progettoImportato, '{"v":1}')
  })
})

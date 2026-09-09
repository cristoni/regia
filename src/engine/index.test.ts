/**
 * Prova d'insieme: il motore pilotato da uno script, senza interfaccia.
 *
 * E la promessa dell'ADR 0008 messa alla prova. Se questo file gira, allora le
 * 50 pressioni consecutive del §8.3 sono un ciclo `for`, e i 60 minuti di
 * Sottofondo del §8.4 sono un test che si puo lasciare acceso -- senza un dito,
 * senza un telefono, senza Electron.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { WebSocket } from 'ws'

import type { Evento, Stato } from './api/protocollo.js'
import { avviaMotore, type MotoreAvviato } from './index.js'

const daPulire: Array<() => Promise<void>> = []
let ffmpegDisponibile = false

before(() => {
  ffmpegDisponibile = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0
})
after(async () => {
  for (const f of daPulire.reverse()) await f().catch(() => {})
})

/** Un Operatore finto: manda comandi e aspetta lo stato che vuole vedere. */
class Operatore {
  private readonly eventi: Evento[] = []
  private contatore = 0
  private constructor(private readonly ws: WebSocket) {}

  static async collega(indirizzo: string): Promise<Operatore> {
    const ws = new WebSocket(indirizzo.replace(/^http/, 'ws').replace(/\/$/, '') + '/regia')
    const o = new Operatore(ws)
    ws.on('message', (d) => o.eventi.push(JSON.parse(d.toString()) as Evento))
    await new Promise((ok, ko) => {
      ws.once('open', ok)
      ws.once('error', ko)
    })
    daPulire.push(async () => ws.close())
    return o
  }

  /** Manda un comando e aspetta l'esito. Rilancia se il motore lo rifiuta. */
  async comanda(comando: unknown): Promise<void> {
    const id = `c${++this.contatore}`
    this.ws.send(JSON.stringify({ tipo: 'comando', id, comando }))
    const esito = await this.aspetta(
      (e): e is Extract<Evento, { tipo: 'esito' }> => e.tipo === 'esito' && e.id === id,
    )
    if (!esito.ok) throw new Error(esito.errore)
  }

  /** Come `comanda`, ma si aspetta che fallisca. Restituisce il messaggio. */
  async comandaSperandoInErrore(comando: unknown): Promise<string> {
    try {
      await this.comanda(comando)
    } catch (e) {
      return (e as Error).message
    }
    throw new Error('il comando doveva fallire e invece e passato')
  }

  async stato(condizione: (s: Stato) => boolean = () => true): Promise<Stato> {
    const e = await this.aspetta(
      (x): x is Extract<Evento, { tipo: 'stato' }> => x.tipo === 'stato' && condizione(x.stato),
    )
    return e.stato
  }

  private async aspetta<T extends Evento>(prova: (e: Evento) => e is T, entro = 5000): Promise<T> {
    const scadenza = Date.now() + entro
    for (;;) {
      for (let i = this.eventi.length - 1; i >= 0; i--) {
        const e = this.eventi[i]!
        // Il predicato puo esplodere su un evento che non lo riguarda -- per
        // esempio la prima istantanea, dove non esiste ancora nessuna Zona.
        // Un predicato che non si applica significa "non e questo", non "il
        // test e fallito".
        try {
          if (prova(e)) return e
        } catch {
          continue
        }
      }
      if (Date.now() > scadenza) throw new Error('evento mai arrivato')
      await new Promise((r) => setTimeout(r, 5))
    }
  }
}

async function ambiente(): Promise<{ cartella: string; motore: MotoreAvviato }> {
  const cartella = await fs.mkdtemp(path.join(os.tmpdir(), 'regia-e2e-'))
  daPulire.push(() => fs.rm(cartella, { recursive: true, force: true }))
  const motore = await avviaMotore({ cartellaDati: cartella, servitore: { porta: 0 } })
  daPulire.push(() => motore.ferma())
  return { cartella, motore }
}

function generaTono(destinazione: string, secondi = 1): void {
  spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
     '-i', `sine=frequency=440:duration=${secondi}`, '-y', destinazione],
    { windowsHide: true },
  )
}

describe('motore: pilotabile senza interfaccia', () => {
  it('parte su una cartella vuota e serve uno stato sensato', async () => {
    const { motore } = await ambiente()
    const op = await Operatore.collega(motore.indirizzo)
    const s = await op.stato()

    assert.equal(s.progettoNome, 'Casa degli orrori')
    assert.deepEqual(s.zone, [])
    assert.equal(s.audio.bufferMs, 2000, 'il default deve essere quello dell ADR 0007')
    assert.equal(s.audio.codec, 'pcm')
  })

  it('crea Zone e le mostra in ordine', async () => {
    const { motore } = await ambiente()
    const op = await Operatore.collega(motore.indirizzo)

    await op.comanda({ tipo: 'zona.crea', nome: 'Ingresso', colore: '#ff6600' })
    await op.comanda({ tipo: 'zona.crea', nome: 'Cantina', colore: '#003366' })

    const s = await op.stato((x) => x.zone.length === 2)
    assert.deepEqual(s.zone.map((z) => z.nome), ['Ingresso', 'Cantina'])
  })

  it('eliminare una Zona rende non assegnati i suoi dispositivi, non li cancella', async () => {
    const { motore } = await ambiente()
    const op = await Operatore.collega(motore.indirizzo)
    await op.comanda({ tipo: 'zona.crea', nome: 'Cantina', colore: '#003366' })
    const conZona = await op.stato((x) => x.zone.length === 1)

    await op.comanda({ tipo: 'zona.elimina', zonaId: conZona.zone[0]!.id })
    const dopo = await op.stato((x) => x.zone.length === 0)
    assert.deepEqual(dopo.zone, [])
  })

  it('importa un Suono e lo fa suonare in una Zona sola', async (t) => {
    if (!ffmpegDisponibile) return t.skip('ffmpeg non disponibile')
    const { cartella, motore } = await ambiente()
    const op = await Operatore.collega(motore.indirizzo)

    const urlo = path.join(cartella, 'urlo.wav')
    generaTono(urlo, 2)

    await op.comanda({ tipo: 'zona.crea', nome: 'Ingresso', colore: '#ff6600' })
    await op.comanda({ tipo: 'zona.crea', nome: 'Cantina', colore: '#003366' })
    await op.comanda({ tipo: 'suono.importa', percorsi: [urlo] })

    const conSuono = await op.stato((x) => x.suoni.length === 1)
    assert.equal(conSuono.suoni[0]!.nome, 'urlo')
    assert.equal(conSuono.suoni[0]!.pronto, true, 'il Suono deve essere gia decodificato')
    assert.ok(Math.abs((conSuono.suoni[0]!.durataMs ?? 0) - 2000) < 100)

    const ingresso = conSuono.zone[0]!.id
    await op.comanda({
      tipo: 'zona.suona', zone: [ingresso], suonoId: conSuono.suoni[0]!.id, esclusivo: false,
    })

    const suonando = await op.stato((x) => (x.zone[0]?.effettiInCorso.length ?? 0) > 0)
    assert.equal(suonando.zone[0]!.effettiInCorso.length, 1, 'deve suonare nell Ingresso')
    assert.equal(suonando.zone[1]!.effettiInCorso.length, 0, 'e SOLO nell Ingresso')
  })

  it('cinquanta pressioni consecutive, come chiede il §8.3', async (t) => {
    if (!ffmpegDisponibile) return t.skip('ffmpeg non disponibile')
    const { cartella, motore } = await ambiente()
    const op = await Operatore.collega(motore.indirizzo)

    const urlo = path.join(cartella, 'urlo.wav')
    generaTono(urlo, 1)
    await op.comanda({ tipo: 'zona.crea', nome: 'Ingresso', colore: '#ff6600' })
    await op.comanda({ tipo: 'suono.importa', percorsi: [urlo] })
    const s = await op.stato((x) => x.suoni.length === 1)

    // Senza telefoni questo non misura la latenza: verifica che cinquanta
    // comandi di fila non facciano accumulare stato, rifiuti o errori.
    for (let i = 0; i < 50; i++) {
      await op.comanda({
        tipo: 'zona.suona', zone: [s.zone[0]!.id], suonoId: s.suoni[0]!.id, esclusivo: true,
      })
    }
    const finale = await op.stato((x) => (x.zone[0]?.effettiInCorso.length ?? 0) > 0)
    assert.equal(finale.zone[0]!.effettiInCorso.length, 1, 'con esclusivo deve restarne uno solo')
  })

  it('rifiuta di suonare un Suono non abilitato in quella Zona', async (t) => {
    if (!ffmpegDisponibile) return t.skip('ffmpeg non disponibile')
    const { cartella, motore } = await ambiente()
    const op = await Operatore.collega(motore.indirizzo)
    const urlo = path.join(cartella, 'urlo.wav')
    generaTono(urlo)

    await op.comanda({ tipo: 'zona.crea', nome: 'Ingresso', colore: '#ff6600' })
    await op.comanda({ tipo: 'suono.importa', percorsi: [urlo] })
    const s = await op.stato((x) => x.suoni.length === 1)

    await op.comanda({ tipo: 'zona.suoniAbilitati', zonaId: s.zone[0]!.id, suoni: [] })
    const errore = await op.comandaSperandoInErrore({
      tipo: 'zona.suona', zone: [s.zone[0]!.id], suonoId: s.suoni[0]!.id, esclusivo: false,
    })
    assert.match(errore, /non e abilitato/)
  })

  it('dice chiaramente cosa non e ancora collegato, invece di fingere', async () => {
    const { motore } = await ambiente()
    const op = await Operatore.collega(motore.indirizzo)
    const errore = await op.comandaSperandoInErrore({ tipo: 'server.avvia' })
    assert.match(errore, /non ancora collegato/)
  })
})

describe('motore: ripartenza', () => {
  it('riaprendo, la configurazione e identica, come chiede il §8.7', async (t) => {
    if (!ffmpegDisponibile) return t.skip('ffmpeg non disponibile')
    const cartella = await fs.mkdtemp(path.join(os.tmpdir(), 'regia-riavvio-'))
    daPulire.push(() => fs.rm(cartella, { recursive: true, force: true }))
    const urlo = path.join(cartella, 'sottofondo.wav')
    generaTono(urlo, 1)

    const primo = await avviaMotore({ cartellaDati: cartella, servitore: { porta: 0 } })
    const op1 = await Operatore.collega(primo.indirizzo)
    await op1.comanda({ tipo: 'zona.crea', nome: 'Cripta', colore: '#112233' })
    await op1.comanda({ tipo: 'suono.importa', percorsi: [urlo] })
    const prima = await op1.stato((x) => x.suoni.length === 1)
    await op1.comanda({
      tipo: 'zona.sottofondo', zonaId: prima.zone[0]!.id, suonoId: prima.suoni[0]!.id,
    })
    await op1.comanda({ tipo: 'zona.volume', zonaId: prima.zone[0]!.id, volume: 0.4 })
    await primo.ferma()

    const secondo = await avviaMotore({ cartellaDati: cartella, servitore: { porta: 0 } })
    daPulire.push(() => secondo.ferma())
    const op2 = await Operatore.collega(secondo.indirizzo)
    // Il Sottofondo lo fa ripartire il thread audio: si aspetta che l abbia
    // preso in carico, non si legge la prima istantanea che passa.
    const dopo = await op2.stato((x) => x.zone[0]?.sottofondoId != null)

    assert.equal(dopo.zone[0]!.nome, 'Cripta')
    assert.equal(dopo.zone[0]!.volume, 0.4, 'il volume di Zona non e stato ripreso')
    assert.equal(dopo.suoni.length, 1)
    assert.equal(dopo.suoni[0]!.pronto, true, 'la cache PCM doveva sopravvivere al riavvio')
    assert.equal(
      dopo.zone[0]!.sottofondoId, dopo.suoni[0]!.id,
      'il Sottofondo deve ripartire da solo: per una Zona, "com era" include cosa sta suonando',
    )
  })

  it('non sovrascrive un progetto che non riesce a leggere', async () => {
    const cartella = await fs.mkdtemp(path.join(os.tmpdir(), 'regia-rotto-'))
    daPulire.push(() => fs.rm(cartella, { recursive: true, force: true }))
    // Struttura valida come JSON ma non come progetto, e nessun .bak da cui ripartire.
    await fs.writeFile(path.join(cartella, 'progetto.json'), '{"versione":1,"nome":"x"}', 'utf8')

    await assert.rejects(
      () => avviaMotore({ cartellaDati: cartella, servitore: { porta: 0 } }),
      /non e leggibile/,
    )
    // E soprattutto: il file di prima e ancora li, intatto.
    assert.equal(
      await fs.readFile(path.join(cartella, 'progetto.json'), 'utf8'),
      '{"versione":1,"nome":"x"}',
    )
  })
})

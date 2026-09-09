import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { progettoVuoto, type ImpostazioniAudio } from '../dominio/progetto.js'
import { GestoreAudio } from './gestore-audio.js'
import type { EventoAudio, FlussoDaServire } from './protocollo-audio.js'
import type { Destinazione } from './scrittore.js'

const AUDIO: ImpostazioniAudio = progettoVuoto('x').audio

class PresaFinta implements Destinazione {
  static aperte: Array<{ host: string; porta: number }> = []
  aperta = true
  byte = 0
  constructor(host: string, porta: number) {
    PresaFinta.aperte.push({ host, porta })
  }
  scrivi(d: Uint8Array): boolean {
    this.byte += d.length
    return true
  }
  async attendiScarico(): Promise<void> {}
  async chiudi(): Promise<void> {
    this.aperta = false
  }
}

/** PCM di prova: n campioni per canale, tutti alla stessa ampiezza. */
function pcm(campioni: number, ampiezza = 5000, canali = AUDIO.canali): Uint8Array {
  const a = new Int16Array(campioni * canali).fill(ampiezza)
  return new Uint8Array(a.buffer)
}

function banco(opzioni: { file?: Map<string, Uint8Array> } = {}) {
  PresaFinta.aperte = []
  const eventi: EventoAudio[] = []
  const file = opzioni.file ?? new Map<string, Uint8Array>()
  const gestore = new GestoreAudio({
    emetti: (e) => eventi.push(e),
    apriPresa: async (host, porta) => new PresaFinta(host, porta),
    leggiFile: async (p) => {
      const d = file.get(p)
      if (!d) throw new Error(`file inesistente: ${p}`)
      return d
    },
  })
  return { gestore, eventi, file }
}

const FLUSSI: FlussoDaServire[] = [
  { id: 'Ingresso', zonaId: 'z1', porta: 4953, volume: 1 },
  { id: 'Cantina', zonaId: 'z2', porta: 4954, volume: 0.5 },
  { id: 'Non assegnati', zonaId: null, porta: 4955, volume: 1 },
]

async function configurato(b = banco()) {
  await b.gestore.esegui({ tipo: 'configura', audio: AUDIO, flussi: FLUSSI, host: '10.0.0.1' })
  return b
}

describe('gestore audio: configurazione', () => {
  it('crea un mixer per ogni Flusso, compreso quello dei non assegnati', async () => {
    const b = await configurato()
    const stato = b.gestore.stato()
    assert.deepEqual(stato.map((f) => f.id), ['Ingresso', 'Cantina', 'Non assegnati'])
    assert.deepEqual(stato.map((f) => f.zonaId), ['z1', 'z2', null])
  })

  it('rispetta il volume iniziale di ogni Zona', async () => {
    const b = await configurato()
    assert.equal(b.gestore.stato()[1]!.volume, 0.5)
  })

  it('non apre nessuna socket finche non gli si dice di partire', async () => {
    await configurato()
    assert.deepEqual(PresaFinta.aperte, [])
  })

  it('avviando apre una socket per Flusso, sull host e sulla porta giusti', async () => {
    const b = await configurato()
    await b.gestore.esegui({ tipo: 'avvia' })
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(
      PresaFinta.aperte,
      [
        { host: '10.0.0.1', porta: 4953 },
        { host: '10.0.0.1', porta: 4954 },
        { host: '10.0.0.1', porta: 4955 },
      ],
    )
    await b.gestore.chiudi()
  })

  it('riconfigurare mentre suona ferma e riparte, senza lasciare socket vecchie', async () => {
    const b = await configurato()
    await b.gestore.esegui({ tipo: 'avvia' })
    await new Promise((r) => setTimeout(r, 60))

    await b.gestore.esegui({
      tipo: 'configura', audio: AUDIO, host: '10.0.0.1',
      flussi: [{ id: 'Solo una', zonaId: 'z9', porta: 5000, volume: 1 }],
    })
    await new Promise((r) => setTimeout(r, 60))

    assert.deepEqual(b.gestore.stato().map((f) => f.id), ['Solo una'])
    assert.ok(
      PresaFinta.aperte.some((p) => p.porta === 5000),
      'doveva riaprire sulla porta nuova, perche era gia avviato',
    )
    await b.gestore.chiudi()
  })
})

describe('gestore audio: i Suoni', () => {
  it('carica dalla cache e conferma con la durata', async () => {
    const file = new Map([['/cache/urlo.pcm', pcm(AUDIO.frequenza)]])
    const b = await configurato(banco({ file }))
    await b.gestore.esegui({ tipo: 'caricaSuono', suonoId: 's1', percorso: '/cache/urlo.pcm' })

    const e = b.eventi.find((x) => x.tipo === 'suonoCaricato')
    assert.equal(e?.tipo === 'suonoCaricato' && e.suonoId, 's1')
    assert.equal(e?.tipo === 'suonoCaricato' && e.durataMs, 1000)
  })

  it('un file mancante viene riferito, non fa esplodere il thread audio', async () => {
    const b = await configurato()
    await b.gestore.esegui({ tipo: 'caricaSuono', suonoId: 's1', percorso: '/non/esiste.pcm' })
    const e = b.eventi.find((x) => x.tipo === 'suonoFallito')
    assert.match(e?.tipo === 'suonoFallito' ? e.errore : '', /inesistente/)
  })

  it('tronca un file che non finisce su un frame intero', async () => {
    // Un byte dispari sarebbe mezzo campione: leggerlo sposterebbe L e R.
    const grezzo = pcm(100)
    const file = new Map([['/cache/x.pcm', grezzo.subarray(0, grezzo.length - 3)]])
    const b = await configurato(banco({ file }))
    await b.gestore.esegui({ tipo: 'caricaSuono', suonoId: 's1', percorso: '/cache/x.pcm' })
    const e = b.eventi.find((x) => x.tipo === 'suonoCaricato')
    assert.equal(e?.tipo, 'suonoCaricato')
  })

  it('rifiuta un file vuoto invece di caricare il nulla', async () => {
    const file = new Map([['/cache/vuoto.pcm', new Uint8Array(0)]])
    const b = await configurato(banco({ file }))
    await b.gestore.esegui({ tipo: 'caricaSuono', suonoId: 's1', percorso: '/cache/vuoto.pcm' })
    assert.ok(b.eventi.some((x) => x.tipo === 'suonoFallito'))
  })
})

describe('gestore audio: riproduzione', () => {
  async function conSuono() {
    const file = new Map([['/cache/urlo.pcm', pcm(AUDIO.frequenza * 2)]])
    const b = await configurato(banco({ file }))
    await b.gestore.esegui({ tipo: 'caricaSuono', suonoId: 'urlo', percorso: '/cache/urlo.pcm' })
    return b
  }

  it('fa partire un Effetto solo nelle Zone richieste', async () => {
    const b = await conSuono()
    await b.gestore.esegui({ tipo: 'suona', zone: ['z1'], suonoId: 'urlo', guadagno: 1, esclusivo: false })

    const stato = b.gestore.stato()
    assert.deepEqual(stato[0]!.effetti.map((e) => e.suonoId), ['urlo'])
    assert.deepEqual(stato[1]!.effetti, [])
  })

  it('suona in piu Zone insieme, per il botto finale', async () => {
    const b = await conSuono()
    await b.gestore.esegui({ tipo: 'suona', zone: ['z1', 'z2'], suonoId: 'urlo', guadagno: 1, esclusivo: false })
    assert.equal(b.gestore.stato()[0]!.effetti.length, 1)
    assert.equal(b.gestore.stato()[1]!.effetti.length, 1)
  })

  it('un pulsante premuto per un Suono non caricato non fa esplodere niente', async () => {
    const b = await configurato()
    await b.gestore.esegui({ tipo: 'suona', zone: ['z1'], suonoId: 'mai-visto', guadagno: 1, esclusivo: false })
    assert.deepEqual(b.gestore.stato()[0]!.effetti, [])
    assert.ok(b.eventi.some((e) => e.tipo === 'diario' && /non caricato/.test(e.testo)))
  })

  it('lo STOP di Zona tocca solo quella Zona', async () => {
    const b = await conSuono()
    await b.gestore.esegui({ tipo: 'suona', zone: ['z1', 'z2'], suonoId: 'urlo', guadagno: 1, esclusivo: false })
    await b.gestore.esegui({ tipo: 'stopZona', zonaId: 'z1' })
    assert.deepEqual(b.gestore.stato()[0]!.effetti, [])
    assert.equal(b.gestore.stato()[1]!.effetti.length, 1)
  })

  it('lo STOP TUTTO ferma ogni Zona, non assegnati compresi', async () => {
    const b = await conSuono()
    await b.gestore.esegui({ tipo: 'suona', zone: ['z1', 'z2'], suonoId: 'urlo', guadagno: 1, esclusivo: false })
    await b.gestore.esegui({ tipo: 'stopTutto' })
    for (const f of b.gestore.stato()) assert.deepEqual(f.effetti, [])
  })

  it('il Sottofondo si accende e si spegne, e non e un Effetto', async () => {
    const b = await conSuono()
    await b.gestore.esegui({ tipo: 'sottofondo', zonaId: 'z1', suonoId: 'urlo', guadagno: 0.3 })
    assert.equal(b.gestore.stato()[0]!.sottofondoAttivo, true)
    assert.deepEqual(b.gestore.stato()[0]!.effetti, [], 'un Sottofondo non e un Effetto')

    await b.gestore.esegui({ tipo: 'sottofondo', zonaId: 'z1', suonoId: null, guadagno: 1 })
    assert.equal(b.gestore.stato()[0]!.sottofondoAttivo, false)
  })

  it('lo STOP di Zona non spegne il Sottofondo', async () => {
    const b = await conSuono()
    await b.gestore.esegui({ tipo: 'sottofondo', zonaId: 'z1', suonoId: 'urlo', guadagno: 0.3 })
    await b.gestore.esegui({ tipo: 'suona', zone: ['z1'], suonoId: 'urlo', guadagno: 1, esclusivo: false })
    await b.gestore.esegui({ tipo: 'stopZona', zonaId: 'z1' })

    assert.deepEqual(b.gestore.stato()[0]!.effetti, [])
    assert.equal(b.gestore.stato()[0]!.sottofondoAttivo, true)
  })

  it('il volume di Zona cambia subito, senza passare da nessun server', async () => {
    const b = await configurato()
    await b.gestore.esegui({ tipo: 'volume', zonaId: 'z2', volume: 0.1 })
    assert.equal(b.gestore.stato()[1]!.volume, 0.1)
  })

  it('un comando su una Zona che non esiste viene ignorato in silenzio', async () => {
    const b = await conSuono()
    await b.gestore.esegui({ tipo: 'volume', zonaId: 'z-mai-vista', volume: 0.5 })
    await b.gestore.esegui({ tipo: 'stopZona', zonaId: 'z-mai-vista' })
    await b.gestore.esegui({ tipo: 'suona', zone: ['z-mai-vista'], suonoId: 'urlo', guadagno: 1, esclusivo: false })
    assert.equal(b.gestore.stato().length, 3)
  })
})

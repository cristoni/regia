import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { progettoVuoto, type Progetto, type Zona } from '../dominio/progetto.js'
import { flussiDi, generaConfigurazione, ID_NON_ASSEGNATI, nomeFlusso } from './configurazione.js'

function zona(id: string, nome: string, ordine: number): Zona {
  return { id, nome, colore: '#ff6600', ordine, volume: 1, sottofondoId: null, suoniAbilitati: null }
}

function progetto(...nomi: string[]): Progetto {
  const p = progettoVuoto('C:/Video/Regia')
  p.zone = nomi.map((n, i) => zona(`z${i + 1}`, n, i))
  return p
}

describe('configurazione: i Flussi', () => {
  it('crea un Flusso per Zona piu quello dei non assegnati', () => {
    const f = flussiDi(progetto('Ingresso', 'Cantina'))
    assert.equal(f.length, 3, 'tre Flussi per due Zone: il terzo e dei non assegnati')
    assert.deepEqual(
      f.map((x) => [x.id, x.zonaId, x.porta]),
      [
        ['Ingresso', 'z1', 4953],
        ['Cantina', 'z2', 4954],
        [ID_NON_ASSEGNATI, null, 4955],
      ],
    )
  })

  it('esiste il Flusso dei non assegnati anche senza nessuna Zona', () => {
    // E il caso del primissimo avvio: i telefoni si collegano prima che
    // qualcuno abbia creato una Zona, e devono avere un posto dove stare.
    const f = flussiDi(progetto())
    assert.equal(f.length, 1)
    assert.equal(f[0]!.zonaId, null)
  })

  it('numera le porte secondo l ordine delle Zone', () => {
    const p = progetto('Ingresso', 'Cantina', 'Soffitta')
    p.zone[0]!.ordine = 2
    p.zone[2]!.ordine = 0
    assert.deepEqual(
      flussiDi(p).map((f) => `${f.id}:${f.porta}`),
      ['Soffitta:4953', 'Cantina:4954', 'Ingresso:4955', `${ID_NON_ASSEGNATI}:4956`],
    )
  })

  it('distingue due Zone che si chiamano uguale, invece di sovrapporne gli stream', () => {
    // Il nome *e* l'identificativo dello stream: due Zone omonime creerebbero
    // due sorgenti con lo stesso id, e il secondo vincerebbe in silenzio.
    const f = flussiDi(progetto('Cantina', 'Cantina', 'cantina'))
    assert.deepEqual(f.slice(0, 3).map((x) => x.id), ['Cantina', 'Cantina (2)', 'cantina (3)'])
  })
})

describe('configurazione: i nomi', () => {
  it('tiene accenti e spazi, che chi prepara i telefoni deve poter leggere', () => {
    assert.equal(nomeFlusso('Salotto grande'), 'Salotto grande')
    assert.equal(nomeFlusso('Cantina perché'), 'Cantina perché')
  })

  it('toglie i caratteri che romperebbero la query o il file', () => {
    assert.equal(nomeFlusso('A&B'), 'A B')
    assert.equal(nomeFlusso('x=1?y'), 'x 1 y')
    assert.equal(nomeFlusso('prima\nseconda'), 'prima seconda')
  })

  it('non produce mai un nome vuoto', () => {
    assert.equal(nomeFlusso('&&&'), 'Zona')
    assert.equal(nomeFlusso('   '), 'Zona')
  })
})

describe('configurazione: il testo generato', () => {
  const { testo } = generaConfigurazione(progetto('Ingresso', 'Cantina'))

  it('scrive esplicitamente i valori che nella 0.35 hanno un default diverso', () => {
    // flac, 48000:16:2 e buffer 1000 sono i default di snapserver: ereditarli
    // significherebbe audio muto su Android e latenza sbagliata.
    assert.match(testo, /^codec = pcm$/m)
    assert.match(testo, /^sampleformat = 44100:16:2$/m)
    assert.match(testo, /^buffer = 2000$/m)
    assert.match(testo, /^chunk_ms = 20$/m)
  })

  it('manda audio anche ai client in muto', () => {
    // Senza questo, "Identifica" (che mette in muto gli altri, ADR 0006) li
    // farebbe uscire dal flusso e risincronizzare al riaccenderli: il §2.2,
    // decine di volte per Setup.
    assert.match(testo, /^send_to_muted = true$/m)
  })

  it('alza idle_threshold su ogni sorgente', () => {
    const sorgenti = testo.split('\n').filter((r) => r.startsWith('source = '))
    assert.equal(sorgenti.length, 3)
    for (const s of sorgenti) assert.match(s, /idle_threshold=2000/)
  })

  it('usa la sezione tcp-control, non la vecchia tcp', () => {
    assert.match(testo, /^\[tcp-control\]$/m)
    assert.ok(!/^\[tcp\]$/m.test(testo), 'la sezione [tcp] e deprecata dalla 0.33')
  })

  it('spegne mDNS e non serve Snapweb', () => {
    assert.match(testo, /^mdns_enabled = false$/m)
    assert.match(testo, /^doc_root = *$/m)
  })

  it('usa un indirizzo numerico per le sorgenti, mai un nome', () => {
    for (const s of testo.split('\n').filter((r) => r.startsWith('source = '))) {
      const host = /^source = tcp:\/\/([^:]+):/.exec(s)?.[1]
      assert.match(host ?? '', /^\d+\.\d+\.\d+\.\d+$/, `host non numerico: ${host}`)
    }
  })

  it('dichiara mode=server su ogni sorgente', () => {
    for (const s of testo.split('\n').filter((r) => r.startsWith('source = '))) {
      assert.match(s, /[?&]mode=server(&|$)/)
    }
  })
})

describe('configurazione: le porte da verificare prima di avviare', () => {
  it('elenca tutte le porte, di controllo e di sorgente', () => {
    // Una sola porta occupata fra queste impedisce l'avvio dell'INTERO server,
    // con un errore opaco: vanno controllate prima, per poter dire quale.
    const c = generaConfigurazione(progetto('A', 'B', 'C'))
    assert.deepEqual([...c.porte].sort((x, y) => x - y), [1704, 1705, 1780, 4953, 4954, 4955, 4956])
  })

  it('non elenca mai la stessa porta due volte', () => {
    const c = generaConfigurazione(progetto('A', 'B'))
    assert.equal(new Set(c.porte).size, c.porte.length)
  })
})

describe('configurazione: rigenerazione', () => {
  it('e deterministica: stesso progetto, stesso testo', () => {
    const a = generaConfigurazione(progetto('Ingresso', 'Cantina')).testo
    const b = generaConfigurazione(progetto('Ingresso', 'Cantina')).testo
    assert.equal(a, b)
  })

  it('cambia se cambiano le Zone, ed e per questo che si riavvia', () => {
    const prima = generaConfigurazione(progetto('Ingresso')).testo
    const dopo = generaConfigurazione(progetto('Ingresso', 'Cantina')).testo
    assert.notEqual(prima, dopo)
  })

  it('segue il codec quando lo si cambia nelle impostazioni', () => {
    const p = progetto('Ingresso')
    p.audio.codec = 'opus'
    const { testo } = generaConfigurazione(p)
    assert.match(testo, /^codec = opus$/m)
    assert.match(testo, /source = .*codec=opus/)
  })
})

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, it } from 'node:test'

import { progettoVuoto, violazioni, portaFlusso, type Progetto } from '../dominio/progetto.js'
import { ArchivioProgetto } from './archivio.js'

const temporanee: string[] = []
async function cartellaTemporanea(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'regia-test-'))
  temporanee.push(d)
  return d
}
after(async () => {
  for (const d of temporanee) await fs.rm(d, { recursive: true, force: true })
})

function progettoDiProva(): Progetto {
  const p = progettoVuoto('C:/Video/Regia')
  p.zone.push(
    { id: 'z1', nome: 'Ingresso', colore: '#ff6600', ordine: 0, volume: 0.8, sottofondoId: null, suoniAbilitati: null },
    { id: 'z2', nome: 'Cantina', colore: '#003366', ordine: 1, volume: 1, sottofondoId: null, suoniAbilitati: null },
  )
  return p
}

describe('archivio del progetto', () => {
  it('segnala che il progetto non esiste ancora, invece di inventarne uno', async () => {
    const d = await cartellaTemporanea()
    const a = new ArchivioProgetto(path.join(d, 'progetto.json'))
    assert.deepEqual(await a.carica(), { stato: 'assente' })
  })

  it('rilegge esattamente cio che ha scritto', async () => {
    const d = await cartellaTemporanea()
    const a = new ArchivioProgetto(path.join(d, 'progetto.json'))
    const p = progettoDiProva()
    await a.salvaOra(p)

    const esito = await a.carica()
    assert.equal(esito.stato, 'caricato')
    if (esito.stato !== 'caricato') return
    assert.deepEqual(esito.progetto, p)
    assert.equal(esito.daBackup, false)
    assert.deepEqual(esito.avvisi, [])
  })

  it('non lascia mai il file temporaneo in giro', async () => {
    const d = await cartellaTemporanea()
    const a = new ArchivioProgetto(path.join(d, 'progetto.json'))
    await a.salvaOra(progettoDiProva())
    const presenti = await fs.readdir(d)
    assert.ok(!presenti.some((f) => f.endsWith('.tmp')), `trovato un residuo: ${presenti.join(', ')}`)
  })

  it('ripiega sulla copia di sicurezza quando il file principale e corrotto', async () => {
    const d = await cartellaTemporanea()
    const percorso = path.join(d, 'progetto.json')
    const a = new ArchivioProgetto(percorso)

    const buono = progettoDiProva()
    await a.salvaOra(buono)
    // La seconda scrittura crea il .bak con dentro la prima.
    const modificato = structuredClone(buono)
    modificato.nome = 'Seconda versione'
    await a.salvaOra(modificato)

    // Ora simuliamo un taglio di corrente a meta scrittura.
    await fs.writeFile(percorso, '{"versione": 1, "zone": [', 'utf8')

    const esito = await a.carica()
    assert.equal(esito.stato, 'caricato')
    if (esito.stato !== 'caricato') return
    assert.equal(esito.daBackup, true)
    assert.equal(esito.progetto.nome, buono.nome)
    assert.match(esito.avvisi[0] ?? '', /copia di sicurezza/)
  })

  it('rifiuta un progetto la cui struttura non torna', async () => {
    const d = await cartellaTemporanea()
    const percorso = path.join(d, 'progetto.json')
    await fs.writeFile(percorso, JSON.stringify({ versione: 1, nome: 'x' }), 'utf8')
    const esito = await new ArchivioProgetto(percorso).carica()
    assert.equal(esito.stato, 'illeggibile')
  })

  it('carica lo stesso un progetto con riferimenti rotti, ma lo dice', async () => {
    const d = await cartellaTemporanea()
    const percorso = path.join(d, 'progetto.json')
    const p = progettoDiProva()
    p.zone[0]!.sottofondoId = 's-sparito'
    await fs.writeFile(percorso, JSON.stringify(p), 'utf8')

    const esito = await new ArchivioProgetto(percorso).carica()
    assert.equal(esito.stato, 'caricato')
    if (esito.stato !== 'caricato') return
    assert.equal(esito.avvisi.length, 1)
    assert.match(esito.avvisi[0]!, /sottofondo inesistente/)
  })

  it('raggruppa le modifiche ravvicinate ma non le perde', async () => {
    const d = await cartellaTemporanea()
    const percorso = path.join(d, 'progetto.json')
    const a = new ArchivioProgetto(percorso)

    const p = progettoDiProva()
    for (let i = 0; i < 50; i++) {
      p.zone[0]!.volume = i / 100
      a.programmaSalvataggio(structuredClone(p))
    }
    await a.chiudi()

    const esito = await a.carica()
    assert.equal(esito.stato, 'caricato')
    if (esito.stato !== 'caricato') return
    assert.equal(esito.progetto.zone[0]!.volume, 49 / 100)
  })

  it('non riscrive il file quando il contenuto non e cambiato', async () => {
    const d = await cartellaTemporanea()
    const percorso = path.join(d, 'progetto.json')
    const a = new ArchivioProgetto(percorso)
    const p = progettoDiProva()

    await a.salvaOra(p)
    const prima = (await fs.stat(percorso)).mtimeMs
    await a.salvaOra(structuredClone(p))
    // Nessun .bak significa che la seconda scrittura non e nemmeno partita.
    await assert.rejects(fs.stat(percorso + '.bak'))
    assert.equal((await fs.stat(percorso)).mtimeMs, prima)
  })
})

/**
 * ADR 0014: la rotazione dichiarata dall'Operatore vive nel progetto, perche
 * un telefono montato di traverso ci resta tutta la serata. Ha un default
 * proprio per non chiedere una migrazione: un progetto scritto prima che il
 * campo esistesse deve aprirsi, con le Telecamere dritte.
 */
describe('la rotazione delle Telecamere nel progetto (ADR 0014)', () => {
  it('apre un progetto vecchio, senza il campo, e mette le Telecamere dritte', async () => {
    const d = await cartellaTemporanea()
    const percorso = path.join(d, 'progetto.json')
    const p = progettoDiProva() as Progetto & { telecamere: unknown[] }
    p.telecamere.push({
      id: 't1', nome: 'Occhio', host: '192.168.1.7', porta: 4444,
      https: false, utente: null, passwordCifrata: null, zonaId: 'z1',
    })
    await fs.writeFile(percorso, JSON.stringify(p), 'utf8')

    const esito = await new ArchivioProgetto(percorso).carica()
    assert.equal(esito.stato, 'caricato', `non si e aperto: ${JSON.stringify(esito)}`)
    if (esito.stato !== 'caricato') return
    assert.equal(esito.progetto.telecamere[0]!.rotazione, 0)
  })

  it('rilegge la rotazione che ha scritto', async () => {
    const d = await cartellaTemporanea()
    const a = new ArchivioProgetto(path.join(d, 'progetto.json'))
    const p = progettoDiProva()
    p.telecamere.push({
      id: 't1', nome: 'Occhio', host: '192.168.1.7', porta: 4444,
      https: false, utente: null, passwordCifrata: null, zonaId: 'z1', rotazione: 270,
    })
    await a.salvaOra(p)
    const esito = await new ArchivioProgetto(path.join(d, 'progetto.json')).carica()
    assert.equal(esito.stato, 'caricato')
    if (esito.stato !== 'caricato') return
    assert.equal(esito.progetto.telecamere[0]!.rotazione, 270)
  })

  it('rifiuta un angolo che non e un quarto di giro', async () => {
    const d = await cartellaTemporanea()
    const percorso = path.join(d, 'progetto.json')
    const p = progettoDiProva() as Progetto & { telecamere: unknown[] }
    p.telecamere.push({
      id: 't1', nome: 'Storta', host: '192.168.1.7', porta: 4444,
      https: false, utente: null, passwordCifrata: null, zonaId: 'z1', rotazione: 45,
    })
    await fs.writeFile(percorso, JSON.stringify(p), 'utf8')
    const esito = await new ArchivioProgetto(percorso).carica()
    assert.notEqual(esito.stato, 'caricato', 'un angolo storto non deve passare lo schema')
  })
})

describe('invarianti del dominio', () => {
  it('accetta un progetto coerente', () => {
    assert.deepEqual(violazioni(progettoDiProva()), [])
  })

  it('trova un Altoparlante appeso a una Zona che non esiste', () => {
    const p = progettoDiProva()
    p.altoparlanti.push({
      id: 'c1',
      nome: 'Cassa cucina',
      zonaId: 'z-inesistente',
      volume: 1,
      muto: false,
      latenzaMs: 0,
      vistoIl: '2026-09-08T00:00:00.000Z',
    })
    const v = violazioni(p)
    assert.equal(v.length, 1)
    assert.match(v[0]!.problema, /zona inesistente/)
  })

  it('trova due Zone con lo stesso id', () => {
    const p = progettoDiProva()
    p.zone.push({ ...p.zone[0]!, ordine: 2 })
    assert.ok(violazioni(p).some((v) => /id duplicato/.test(v.problema)))
  })
})

describe('porte dei Flussi', () => {
  it('assegna le porte secondo l ordine delle Zone, non secondo l id', () => {
    const p = progettoDiProva()
    assert.equal(portaFlusso(p, 'z1'), 4953)
    assert.equal(portaFlusso(p, 'z2'), 4954)

    // Riordinando le Zone si riordinano le porte: e il motivo per cui cambiare
    // le Zone impone di rigenerare la configurazione e riavviare (ADR 0005).
    p.zone[0]!.ordine = 1
    p.zone[1]!.ordine = 0
    assert.equal(portaFlusso(p, 'z1'), 4954)
    assert.equal(portaFlusso(p, 'z2'), 4953)
  })

  it('risponde null per una Zona che non c e', () => {
    assert.equal(portaFlusso(progettoDiProva(), 'boh'), null)
  })
})
